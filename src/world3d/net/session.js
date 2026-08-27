// Online session orchestrator: owns the transport room, the lobby reducer, clock sync, and (on the host) the
// authoritative live race. main.js drives it once per frame and renders whatever `session.live` exposes
// (a trial-shaped object: the host's sim or the client's RemoteRace).
import { openRoom } from './transport.js';
import { initialLobby, reduce, rosterMessage, canStart, racers, ROLES, pickOrder } from './lobby.js';
import { MSG, FLAG, packSnapshot, unpackSnapshot, InputCoalescer, PROTOCOL_VERSION } from './protocol.js';
import { ClockSync } from './clock.js';
import { makeRoomCode, makeClientId, normalizeRoomCode } from './codes.js';
import { createTrial } from '../trial.js';
import { createRemoteRace } from './remote-race.js';

export const SNAP_HZ = 12;
const INPUT_STALE_MS = 1200; // no input for this long -> autopilot
const COUNTDOWN_MS = 4200; // start is scheduled this far ahead so every phone has it before GO
export { ROLES, canStart, racers, pickOrder, normalizeRoomCode, makeRoomCode };

export function clientId() {
  try {
    let id = localStorage.getItem('ddw:cid');
    if (!id) { id = makeClientId(); localStorage.setItem('ddw:cid', id); }
    // several tabs on one machine (tests, TV + phone emulation) must not share an identity
    if (window.name && window.name.startsWith('ddw-')) return window.name.slice(4);
    if (sessionStorage.getItem('ddw:tab')) return sessionStorage.getItem('ddw:tab');
    const tab = id + '-' + makeClientId().slice(0, 4);
    sessionStorage.setItem('ddw:tab', tab);
    return tab;
  } catch { return makeClientId(); }
}

/**
 * createSession({ role: 'host'|'guest'|'spectator', code?, name, kind?, relayUrl?, hooks })
 * hooks: {
 *   onLobby(state)                       lobby state changed (render UI)
 *   onStatus(text, level)                connection status line
 *   onCountdown({ startAtLocal, names, mySlot, seed, raceNo })   schedule grid/countdown; the race object is session.live
 *   onRaceEvent(ev)                      host race events (also delivered through live.drain())
 *   onOver({ order, times, picks, names, rule })   canonical result
 *   onAbort(reason)                      host lost / race voided -> back to lobby
 *   onFallback({ names, seed, startAtLocal, rule, mySlot })   "let the ducks decide"
 * }
 */
export function createSession({ role, code, name, kind, relayUrl, hooks = {} }) {
  const cid = clientId();
  const isHostInit = role === 'host';
  code = isHostInit ? (code || makeRoomCode()) : normalizeRoomCode(code || '') || code;
  let lobby = initialLobby({ code, hostCid: isHostInit ? cid : null, meCid: cid, now: Date.now() });
  let room = null;
  const clock = new ClockSync();
  const coalescer = new InputCoalescer();
  const s = {
    cid,
    code,
    role,
    get lobby() { return lobby; },
    get isHost() { return lobby.hostCid === cid; },
    live: null, // trial-shaped race object while racing
    mySlot: -1,
    startAtLocal: null,
    raceNo: 0,
    connected: false,
    lastHostSeen: 0,
    clock,
    stats: { snapsIn: 0, inputsIn: 0, inputsOut: 0, snapsOut: 0 },
  };
  const say = (t, lvl = 'info') => hooks.onStatus && hooks.onStatus(t, lvl);
  const emitLobby = () => hooks.onLobby && hooks.onLobby(lobby, s);
  function dispatch(a) { lobby = reduce(lobby, { now: Date.now(), ...a }); emitLobby(); }

  // ------------------------------------------------------------------ connect
  async function connect() {
    say('Connecting…');
    try {
      room = await openRoom({ kind, code, cid, relayUrl, meta: { name, role } });
    } catch (e) {
      say(`Could not connect: ${e.message || e}`, 'error');
      throw e;
    }
    s.connected = true;
    say(s.isHost ? 'Hosting' : 'Connected', 'ok');
    wire();
    // announce ourselves; guests wait for the host's roster to learn who the host is
    dispatch({ type: 'hello', cid, name, role: role === 'spectator' ? ROLES.spectator : undefined });
    room.send('control', MSG.hello, { cid, name, role, v: PROTOCOL_VERSION });
    if (s.isHost) broadcastRoster();
    else { helloTimer = setInterval(() => { if (!lobby.hostCid) room.send('control', MSG.hello, { cid, name, role, v: PROTOCOL_VERSION }); }, 1500); }
    pingTimer = setInterval(sendPing, 700);
    return s;
  }
  let helloTimer = null;
  let pingTimer = null;
  let rosterTimer = null;

  function broadcastRoster() {
    if (!s.isHost || !room) return;
    room.send('control', MSG.roster, rosterMessage(lobby));
  }

  function wire() {
    room.onPresence((members) => {
      const online = new Set(members.map((m) => m.cid));
      for (const p of Object.values(lobby.players)) {
        if (!online.has(p.cid) && p.online && p.cid !== cid) dispatch({ type: 'leave', cid: p.cid });
      }
      for (const m of members) if (lobby.players[m.cid] && !lobby.players[m.cid].online) dispatch({ type: 'seen', cid: m.cid });
      if (s.isHost) broadcastRoster();
      // host presence lost while racing -> abort (v1 policy)
      if (!s.isHost && lobby.hostCid && !online.has(lobby.hostCid) && (lobby.phase === 'race' || lobby.phase === 'countdown')) hostLost('The host disconnected');
    });
    // ---- control channel
    room.on('control', MSG.hello, (p) => {
      dispatch({ type: 'hello', cid: p.cid, name: p.name, role: p.role === 'spectator' ? ROLES.spectator : undefined });
      if (s.isHost) broadcastRoster();
    });
    room.on('control', MSG.claim, (p) => { dispatch({ type: 'claim', cid: p.cid, duck: p.duck }); if (s.isHost) broadcastRoster(); });
    room.on('control', 'spectate', (p) => { dispatch({ type: 'spectate', cid: p.cid }); if (s.isHost) broadcastRoster(); });
    room.on('control', MSG.ready, (p) => { dispatch({ type: 'ready', cid: p.cid, ready: p.ready }); if (s.isHost) broadcastRoster(); });
    room.on('control', MSG.roster, (p) => {
      if (s.isHost) return; // we are the authority
      s.lastHostSeen = Date.now();
      lobby = reduce(lobby, { type: 'roster', ...p, now: Date.now() });
      if (lobby.players[cid]) s.mySlot = lobby.players[cid].duck;
      emitLobby();
    });
    room.on('control', MSG.config, (p) => { if (!s.isHost) dispatch({ type: 'config', config: p }); });
    room.on('control', MSG.handoff, (p) => {
      dispatch({ type: 'handoff', to: p.to });
      say(lobby.hostCid === cid ? 'You are now the host' : 'Host changed', 'ok');
      if (s.isHost) broadcastRoster();
    });
    room.on('control', MSG.start, (p) => { if (!s.isHost) beginCountdown(p); });
    room.on('control', MSG.over, (p) => { if (!s.isHost) finishRace(p); });
    room.on('control', MSG.rematch, () => { if (!s.isHost) { dispatch({ type: 'rematch' }); s.live = null; hooks.onRematch && hooks.onRematch(); } });
    room.on('control', MSG.abort, (p) => { if (!s.isHost) hostLost(p.reason || 'Race stopped by the host'); });
    room.on('control', MSG.fallback, (p) => { if (!s.isHost) runFallback(p); });
    room.on('control', 'kick', (p) => { if (p.cid === cid) { say('Removed by the host', 'error'); leave(); hooks.onAbort && hooks.onAbort('Removed by the host'); } else dispatch({ type: 'forget', cid: p.cid }); });
    // ---- input channel (host consumes)
    room.on('input', MSG.input, (p) => {
      if (!s.isHost) return;
      s.stats.inputsIn++;
      const slot = slotOf(p.c);
      if (slot >= 0) { inputs[slot] = p.s; inputAt[slot] = Date.now(); }
      seen(p.c);
    });
    room.on('input', MSG.ping, (p) => {
      if (!s.isHost) return;
      room.send('state', MSG.pong, { c: p.c, t0: p.t0, th: performance.now() });
      seen(p.c);
    });
    // ---- state channel (everyone but the host consumes)
    room.on('state', MSG.pong, (p) => {
      if (p.c !== cid) return;
      clock.addSample(p.t0, performance.now(), p.th);
      s.lastHostSeen = Date.now();
    });
    room.on('state', MSG.snap, (arr) => {
      if (s.isHost) return;
      s.lastHostSeen = Date.now();
      s.stats.snapsIn++;
      const snap = unpackSnapshot(arr, unpackTarget);
      if (snap && s.live && s.live.applySnapshot) s.live.applySnapshot(snap);
    });
    room.on('state', MSG.ev, (p) => {
      if (s.isHost) return;
      if (s.live && s.live.applyEvents) s.live.applyEvents(p.list || []);
    });
  }
  const unpackTarget = { t: 0, tick: 0, ducks: [] };
  function seen(c) { const p = lobby.players[c]; if (p && (!p.online || Date.now() - p.lastSeen > 500)) { lobby = reduce(lobby, { type: 'seen', cid: c, now: Date.now() }); } }
  function slotOf(c) { const p = lobby.players[c]; return p ? p.duck : -1; }
  function sendPing() {
    if (!room || s.isHost) return;
    room.send('input', MSG.ping, { c: cid, t0: performance.now() });
  }

  // ------------------------------------------------------------------ lobby actions (local user)
  function setName(n) { name = String(n || '').slice(0, 22) || 'Duck'; dispatch({ type: 'hello', cid, name }); room && room.send('control', MSG.hello, { cid, name, role, v: PROTOCOL_VERSION }); if (s.isHost) broadcastRoster(); }
  function claim(duck) { dispatch({ type: 'claim', cid, duck }); room && room.send('control', MSG.claim, { cid, duck }); if (s.isHost) broadcastRoster(); }
  function spectate() { dispatch({ type: 'spectate', cid }); room && room.send('control', 'spectate', { cid }); if (s.isHost) broadcastRoster(); }
  function setReady(ready) { dispatch({ type: 'ready', cid, ready }); room && room.send('control', MSG.ready, { cid, ready }); if (s.isHost) broadcastRoster(); }
  function setConfig(cfg) { if (!s.isHost) return; dispatch({ type: 'config', config: cfg }); room.send('control', MSG.config, lobby.config); broadcastRoster(); }
  function handoff(to) { if (!s.isHost || !lobby.players[to]) return; room.send('control', MSG.handoff, { to }); dispatch({ type: 'handoff', to }); }
  function kick(c) { if (!s.isHost) return; room.send('control', 'kick', { cid: c }); dispatch({ type: 'forget', cid: c }); broadcastRoster(); }

  // ------------------------------------------------------------------ race: host side
  let hostRace = null;
  const inputs = []; // slot -> latest steer
  const inputAt = []; // slot -> ms
  let snapTick = 0;
  let evOut = [];
  let slotToCid = [];
  function startRace({ seed } = {}) {
    if (!s.isHost || !canStart(lobby)) return false;
    const rs = racers(lobby);
    // slots may be sparse (someone left): compact to 0..n-1 in slot order
    slotToCid = rs.map((p) => p.cid);
    const names = rs.map((p) => p.name);
    const raceSeed = seed ?? (Math.floor(Math.random() * 2 ** 31) >>> 0);
    const startAt = performance.now() + COUNTDOWN_MS; // host clock
    const raceNo = lobby.raceNo + 1;
    const msg = { startAt, seed: raceSeed, names, cids: slotToCid, raceNo, items: lobby.config.items, rule: lobby.config.rule };
    room.send('control', MSG.start, msg);
    setTimeout(() => room && room.send('control', MSG.start, msg), 400); // belt and braces: a second copy
    beginCountdown(msg, true);
    return true;
  }
  function beginCountdown(msg, asHost = false) {
    dispatch({ type: 'start', startAt: msg.startAt, raceNo: msg.raceNo });
    s.raceNo = msg.raceNo;
    slotToCid = msg.cids;
    s.mySlot = msg.cids.indexOf(cid);
    const humans = new Set(msg.cids.map((_, i) => i));
    if (asHost) {
      hostRace = createTrial({ names: msg.names, playerIndex: Math.max(0, s.mySlot), humans, seed: msg.seed });
      for (let i = 0; i < msg.names.length; i++) { inputs[i] = null; inputAt[i] = 0; }
      s.live = hostRace;
      s.startAtLocal = msg.startAt; // host clock == local clock
      lastSnapAt = 0;
      clearInterval(hostTimer);
      hostTimer = setInterval(hostLoop, 16);
    } else {
      s.live = createRemoteRace({ names: msg.names, myIndex: s.mySlot, seed: msg.seed });
      s.startAtLocal = clock.ready ? clock.toLocal(msg.startAt) : performance.now() + COUNTDOWN_MS - 150;
    }
    snapTick = 0;
    hooks.onCountdown && hooks.onCountdown({ startAtLocal: s.startAtLocal, names: msg.names, mySlot: s.mySlot, seed: msg.seed, raceNo: msg.raceNo, rule: msg.rule });
  }
  /** Host race time in seconds "now" (negative during the countdown). */
  function raceTime() { return s.startAtLocal === null ? 0 : (performance.now() - s.startAtLocal) / 1000; }

  /**
   * Per-frame driver. Host: advance the sim with everyone's inputs, broadcast snapshots/events, decide the end.
   * Guest: send my input (coalesced), advance prediction/interpolation. Returns the live object or null.
   */
  // The host's sim + broadcast run on their own timer (wall-clock driven), independent of the render frame rate:
  // a slow or hidden host tab must not slow the race down for everyone else.
  let mySteerLatest = 0;
  let lastSnapAt = 0;
  let hostTimer = null;
  function hostLoop() {
    if (!s.isHost || !hostRace || lobby.phase === 'results' || lobby.phase === 'lobby') return;
    const now = performance.now();
    const rt = raceTime();
    if (lobby.phase === 'countdown' && rt >= 0) dispatch({ type: 'racing' });
    if (rt < 0) return;
    // catch the sim up to wall-clock race time in fixed steps (everyone's clocks mean the same thing)
    let guard = 0;
    while (hostRace.t < rt && guard++ < 90) {
      const step = Math.min(1 / 30, rt - hostRace.t);
      hostRace.step(step, (i) => (i === s.mySlot ? mySteerLatest : (now - (inputAt[i] || 0) < INPUT_STALE_MS ? inputs[i] : null)));
    }
    const evs = hostRace.drain();
    if (evs.length) { evOut.push(...evs); pendingLocal.push(...evs); }
    if (now - lastSnapAt >= 1000 / SNAP_HZ - 2) {
      lastSnapAt = now;
      const ducks = hostRace.ducks.map((d) => ({ s: d.s, lat: d.lat, v: d.v, flags: (d.state.boosting ? FLAG.boosting : 0) | (d.state.spinning ? FLAG.spinning : 0) | (d.state.airborne ? FLAG.airborne : 0) | (d.finishTime !== null ? FLAG.finished : 0) | (d.autopilot ? FLAG.ai : 0) | (d.state.bonk ? FLAG.bonk : 0) }));
      room.send('state', MSG.snap, packSnapshot(hostRace.t, snapTick++, ducks));
      s.stats.snapsOut++;
      if (evOut.length) { room.send('state', MSG.ev, { list: evOut }); evOut = []; }
    }
    // finish: everyone home, or 25 s after the first human finishes, or 100 s total
    const humanTimes = slotToCid.map((_, i) => hostRace.race.finishTimes[i]).filter((x) => x !== null);
    const firstHuman = humanTimes.length ? Math.min(...humanTimes) : null;
    if (hostRace.done || (firstHuman !== null && hostRace.t > firstHuman + 25) || hostRace.t > 100) hostFinish();
  }
  const pendingLocal = []; // host: events for the local HUD, delivered on the next render tick

  function tick(dt, mySteer) {
    if (!s.live || lobby.phase === 'results' || lobby.phase === 'lobby') return s.live;
    const now = performance.now();
    const rt = raceTime();
    if (lobby.phase === 'countdown' && rt >= 0) dispatch({ type: 'racing' });
    if (s.isHost && hostRace) {
      mySteerLatest = mySteer;
      if (pendingLocal.length) { for (const e of pendingLocal.splice(0)) hooks.onRaceEvent && hooks.onRaceEvent(e); }
    } else if (s.live && s.live.step) {
      // guest
      if (rt >= 0 && s.mySlot >= 0 && lobby.phase !== 'results') {
        const m = coalescer.offer(mySteer, 0, now);
        if (m) { room.send('input', MSG.input, { c: cid, t: Math.round(rt * 1000), s: m.s, b: m.b }); s.stats.inputsOut++; }
      }
      s.live.step(dt, rt, mySteer);
      // host silent for 4 s mid-race -> void
      if (rt > 2 && Date.now() - s.lastHostSeen > 4000) hostLost('Lost the host — no data for 4 s');
    }
    return s.live;
  }
  function hostFinish() {
    if (!hostRace || lobby.phase === 'results') return;
    clearInterval(hostTimer);
    hostTimer = null;
    // settle stragglers off-screen so the order is complete and canonical
    let guard = 0;
    while (!hostRace.done && guard++ < 4000) hostRace.step(0.05, () => null);
    const order = hostRace.race.order.slice();
    const times = {};
    hostRace.race.finishTimes.forEach((ft, i) => { times[i] = ft === null ? null : +ft.toFixed(3); });
    const msg = { order, times, raceNo: s.raceNo, cids: slotToCid, rule: lobby.config.rule };
    room.send('control', MSG.over, msg);
    setTimeout(() => room && room.send('control', MSG.over, msg), 500);
    finishRace(msg);
  }
  function finishRace(msg) {
    if (lobby.phase === 'results' && lobby.results && lobby.results.raceNo === msg.raceNo) return;
    const orderCids = msg.order.map((i) => msg.cids[i]);
    dispatch({ type: 'over', order: orderCids, times: msg.times, raceNo: msg.raceNo });
    if (s.live && s.live.applyResult) s.live.applyResult(msg.order, msg.times);
    const names = msg.cids.map((c) => (lobby.players[c] ? lobby.players[c].name : '—'));
    hooks.onOver && hooks.onOver({ order: msg.order, times: msg.times, cids: msg.cids, names, rule: msg.rule || lobby.config.rule, picks: pickOrder(msg.order, msg.rule || lobby.config.rule), raceNo: msg.raceNo });
  }
  function hostLost(reason) {
    if (lobby.phase === 'lobby') return;
    dispatch({ type: 'rematch' });
    s.live = null;
    hooks.onAbort && hooks.onAbort(reason);
  }
  function rematch() {
    if (!s.isHost) return;
    clearInterval(hostTimer);
    room.send('control', MSG.rematch, {});
    dispatch({ type: 'rematch' });
    s.live = null;
    hostRace = null;
    broadcastRoster();
    hooks.onRematch && hooks.onRematch();
  }
  function abortRace(reason = 'Race stopped by the host') {
    if (!s.isHost) return;
    clearInterval(hostTimer);
    room.send('control', MSG.abort, { reason });
    dispatch({ type: 'rematch' });
    s.live = null;
    hostRace = null;
    hooks.onAbort && hooks.onAbort(reason);
  }
  /** "Let the ducks decide": everyone plays the deterministic seeded race locally with a synced start. */
  function fallback() {
    if (!s.isHost) return;
    const rs = racers(lobby);
    const msg = { names: rs.map((p) => p.name), cids: rs.map((p) => p.cid), seed: (Math.floor(Math.random() * 2 ** 31) >>> 0), startAt: performance.now() + 6000, rule: lobby.config.rule, items: lobby.config.items };
    room.send('control', MSG.fallback, msg);
    setTimeout(() => room && room.send('control', MSG.fallback, msg), 400);
    runFallback(msg, true);
  }
  function runFallback(msg, asHost = false) {
    const startAtLocal = asHost || !clock.ready ? msg.startAt : clock.toLocal(msg.startAt);
    s.mySlot = msg.cids.indexOf(cid);
    dispatch({ type: 'start', startAt: msg.startAt, raceNo: lobby.raceNo + 1 });
    hooks.onFallback && hooks.onFallback({ names: msg.names, seed: msg.seed, startAtLocal, rule: msg.rule, items: msg.items, mySlot: s.mySlot });
  }
  /** Host tells everyone the seeded fallback race is over (so lobbies converge on results/rematch). */
  function fallbackOver(order, times) {
    if (!s.isHost) return;
    const rs = racers(lobby);
    const msg = { order, times, raceNo: lobby.raceNo, cids: rs.map((p) => p.cid), rule: lobby.config.rule };
    room.send('control', MSG.over, msg);
    finishRace(msg);
  }

  async function leave() {
    clearInterval(hostTimer);
    clearInterval(helloTimer);
    clearInterval(pingTimer);
    clearInterval(rosterTimer);
    if (room) { try { await room.leave(); } catch { /* ignore */ } }
    room = null;
    s.connected = false;
  }
  // periodic roster heartbeat from the host (late joiners, lost packets) + connection freshness for the UI
  rosterTimer = setInterval(() => { if (s.isHost && room) broadcastRoster(); emitLobby(); }, 2000);

  Object.assign(s, { connect, setName, claim, spectate, setReady, setConfig, handoff, kick, startRace, tick, raceTime, rematch, abortRace, fallback, fallbackOver, leave });
  return s;
}
