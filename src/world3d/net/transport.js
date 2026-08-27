// Transport seam for the online Grand Prix. A Room exposes three logical channels (control / input / state,
// see PHASE4-GRAND-PRIX.md) plus presence. Two implementations:
//   - supabase: Supabase Realtime broadcast + presence (production)
//   - relay:    a tiny WebSocket relay (tools/relay.mjs) used by headless tests where Supabase is unreachable
// Both deliver the same callbacks, so lobby/host/client code never knows which one it is talking to.
//
//   const room = await openRoom({ kind, code, cid, meta, url, key })
//   room.send('control'|'input'|'state', type, payload)
//   room.on('control'|'input'|'state', type | '*', (payload, type) => ...)
//   room.onPresence((members: [{cid, ...meta}]) => ...) ; room.track(meta)
//   room.leave()
import { NET_CONFIG } from './net-config.js';

export async function openRoom(opts) {
  const kind = opts.kind || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('relay') ? 'relay' : 'supabase');
  if (kind === 'relay') return openRelayRoom(opts);
  return openSupabaseRoom(opts);
}

function makeEmitter() {
  const handlers = { control: new Map(), input: new Map(), state: new Map() };
  return {
    on(chan, type, fn) {
      const m = handlers[chan];
      if (!m.has(type)) m.set(type, new Set());
      m.get(type).add(fn);
      return () => m.get(type).delete(fn);
    },
    emit(chan, type, payload) {
      const m = handlers[chan];
      const a = m.get(type);
      if (a) for (const fn of a) { try { fn(payload, type); } catch (e) { console.error(e); } }
      const any = m.get('*');
      if (any) for (const fn of any) { try { fn(payload, type); } catch (e) { console.error(e); } }
    },
  };
}

// --------------------------------------------------------------------------------- Supabase Realtime
let sbClient = null;
function supabaseClient(url, key) {
  if (sbClient) return sbClient;
  const sb = typeof window !== 'undefined' ? window.supabase : null;
  if (!sb || !sb.createClient) throw new Error('supabase-js not loaded (vendor/supabase/supabase.js)');
  sbClient = sb.createClient(url || NET_CONFIG.supabaseUrl, key || NET_CONFIG.supabaseKey, {
    realtime: { params: { eventsPerSecond: 40 } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return sbClient;
}

async function openSupabaseRoom({ code, cid, meta = {}, url, key, subscribe = { control: true, input: true, state: true } }) {
  const client = supabaseClient(url, key);
  const em = makeEmitter();
  const names = { control: `room:${code}`, input: `room:${code}:in`, state: `room:${code}:out` };
  const chans = {};
  let presenceCb = () => {};
  const status = { control: 'idle', input: 'idle', state: 'idle' };
  const openOne = (chan) => new Promise((resolve, reject) => {
    const isControl = chan === 'control';
    const ch = client.channel(names[chan], {
      config: {
        broadcast: { self: false, ack: false },
        presence: isControl ? { key: cid } : undefined,
      },
    });
    ch.on('broadcast', { event: '*' }, (msg) => em.emit(chan, msg.event, msg.payload));
    if (isControl) {
      const fire = () => {
        const st = ch.presenceState();
        const members = Object.entries(st).map(([k, arr]) => ({ cid: k, ...(arr[arr.length - 1] || {}) }));
        presenceCb(members);
      };
      ch.on('presence', { event: 'sync' }, fire);
      ch.on('presence', { event: 'join' }, fire);
      ch.on('presence', { event: 'leave' }, fire);
    }
    const timer = setTimeout(() => reject(new Error(`subscribe timeout (${chan})`)), 12000);
    ch.subscribe(async (st) => {
      status[chan] = st;
      if (st === 'SUBSCRIBED') {
        clearTimeout(timer);
        if (isControl) { try { await ch.track({ ...meta, at: Date.now() }); } catch { /* presence is best effort */ } }
        resolve(ch);
      } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') {
        clearTimeout(timer);
        reject(new Error(`channel ${chan}: ${st}`));
      }
    });
    chans[chan] = ch;
  });
  // only subscribe to what this role needs (host: all; player: control+state (+input to send); spectator: control+state)
  await openOne('control');
  if (subscribe.state !== false) await openOne('state');
  if (subscribe.input !== false) await openOne('input');
  return {
    kind: 'supabase',
    code,
    cid,
    status,
    send(chan, type, payload) {
      const ch = chans[chan];
      if (!ch) return false;
      ch.send({ type: 'broadcast', event: type, payload });
      return true;
    },
    on: em.on,
    onPresence(fn) { presenceCb = fn; },
    async track(m) { if (chans.control) { try { await chans.control.track({ ...m, at: Date.now() }); } catch { /* ignore */ } } },
    async leave() { for (const ch of Object.values(chans)) { try { await client.removeChannel(ch); } catch { /* ignore */ } } },
  };
}

// --------------------------------------------------------------------------------- local relay (tests)
async function openRelayRoom({ code, cid, meta = {}, relayUrl }) {
  const url = relayUrl || (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('relay') : null) || 'ws://localhost:8787';
  const em = makeEmitter();
  let presenceCb = () => {};
  let members = [];
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('relay connect timeout')), 8000);
    ws.onopen = () => { clearTimeout(to); resolve(); };
    ws.onerror = () => { clearTimeout(to); reject(new Error('relay connect error')); };
  });
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.kind === 'presence') { members = m.members; presenceCb(members); return; }
    if (m.kind === 'msg' && m.room === code) em.emit(m.chan, m.type, m.payload);
  };
  ws.send(JSON.stringify({ kind: 'join', room: code, cid, meta }));
  return {
    kind: 'relay',
    code,
    cid,
    status: { control: 'SUBSCRIBED', input: 'SUBSCRIBED', state: 'SUBSCRIBED' },
    send(chan, type, payload) {
      if (ws.readyState !== 1) return false;
      ws.send(JSON.stringify({ kind: 'msg', room: code, chan, type, payload }));
      return true;
    },
    on: em.on,
    onPresence(fn) { presenceCb = fn; if (members.length) fn(members); },
    async track(m) { if (ws.readyState === 1) ws.send(JSON.stringify({ kind: 'track', room: code, cid, meta: m })); },
    async leave() { try { ws.close(); } catch { /* ignore */ } },
    _ws: ws,
  };
}
