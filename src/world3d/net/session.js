// Online session orchestrator: owns the transport room, the lobby reducer, clock sync, and (on the host) the
// authoritative live race. main.js drives it once per frame and renders whatever `session.live` exposes
// (a trial-shaped object: the host's sim or the client's RemoteRace).
import { openRoom } from './transport.js';
import { initialLobby, reduce, rosterMessage, canStart, racers, ROLES, pickOrder, seriesStandings } from './lobby.js';
import { MSG, FLAG, packSnapshot, unpackSnapshot, InputCoalescer, PROTOCOL_VERSION, ratePolicy } from './protocol.js';
import { ClockSync } from './clock.js';
import { makeRoomCode, makeClientId, normalizeRoomCode } from './codes.js';
import { createTrial } from '../trial.js';
import { createRemoteRace } from './remote-race.js';
import { createRtcStar } from './rtc.js';

export const SNAP_HZ = 12; // ceiling; the live rate comes from ratePolicy(racers)
const INPUT_STALE_MS = 2000; // no input for this long -> autopilot (heartbeats arrive every 600 ms)
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
export function createSession(opts) {
  let { role, code, name, kind, relayUrl, hooks = {} } = opts;
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
  const netlog = (...a) => { try { console.info('[net]', ...a); } catch { /* ignore */ } };
  // WebRTC star for race traffic (frames down, inputs up); Realtime keeps lobby + signalling + any peer that can't connect
  const rtcWanted = opts.rtc !== false && !(typeof location !== 'undefined' && /[?&]rtc=0/.test(location.search));
  const rtc = createRtcStar({
    cid,
    isHost: () => s.isHost,
    hostCid: () => lobby.hostCid,
    signal: (to, kind, data) => room && room.send('control', kind, { to, from: cid, ...data }),
    onFrame: (f) => onFrameIn(f, true),
    onInput: (from, p) => onInputIn({ ...p, c: from }),
    onChange: () => updateStateSubscription(),
  });
  let lastFrameTick = -1;
  const emitLobby = () => hooks.onLobby && hooks.onLobby(lobby, s);
  function dispatch(a) { lobby = reduce(lobby, { now: Date.now(), ...a }); emitLobby(); }

  // ------------------------------------------------------------------ connect
  async function connect() {
    say('Connecting…');
    netlog(`${role} entering room ${code}`);
    try {
      room = await openRoom({ kind, code, cid, relayUrl, meta: { name, role } });
    } catch (e) {
      say(`Could not connect: ${e.message || e}`, 'error');
      throw e;
    }
    s.connected = true;
    netlog(`${s.isHost ? 'hosting' : 'joined'} room ${code} as ${cid} via ${room.kind}`);
    say(s.isHost ? 'Hosting' : 'Connected', 'ok');
    wire();
    // announce ourselves; guests wait for the host's roster to learn who the host is
    dispatch({ type: 'hello', cid, name, role: role === 'spectator' ? ROLES.spectator : undefined });
    room.send('control', MSG.hello, { cid, name, role, v: PROTOCOL_VERSION, rtc: rtcWanted && rtc.supported });
    if (s.isHost) broadcastRoster();
    else { helloTimer = setInterval(() => { if (!lobby.hostCid) room.send('control', MSG.hello, { cid, name, role, v: PROTOCOL_VERSION, rtc: rtcWanted && rtc.supported }); }, 1500); }
    pingTimer = setInterval(sendPing, 3000);
    for (let k = 1; k <= 6; k++) setTimeout(sendPing, k * 180); // quick burst to lock the clock
    return s;
  }
  let helloTimer = null;
  let pingTimer = null;
  let rosterTimer = null;

  /** Host-authored control message (carries `from` so guests can ignore anyone who is not their host). */
  function hostSend(type, payload) { if (room) room.send('control', type, { ...payload, from: cid }); }
  /** Guests: is this control message from the host we know (or do we not know a host yet)? */
  function fromHost(p) { return !lobby.hostCid || !p || p.from === undefined || p.from === lobby.hostCid; }
  function broadcastRoster() {
    if (!s.isHost || !room) return;
    hostSend(MSG.roster, rosterMessage(lobby));
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
      if (s.isHost) {
        broadcastRoster();
        if (rtcWanted && rtc.supported && p.rtc !== false) rtc.connectTo(p.cid); // open a data-channel link to this participant
        // someone (re)joined mid-race: hand them the running race so they drop straight in (their duck is on autopilot until their first input)
        if (lastStartMsg && (lobby.phase === 'countdown' || lobby.phase === 'race')) hostSend(MSG.start, { ...lastStartMsg, hostNow: performance.now() });
        if (lastOverMsg && lobby.phase === 'results') hostSend(MSG.over, lastOverMsg);
      }
    });
    room.on('control', MSG.claim, (p) => { dispatch({ type: 'claim', cid: p.cid, duck: p.duck }); if (s.isHost) broadcastRoster(); });
    room.on('control', 'spectate', (p) => { dispatch({ type: 'spectate', cid: p.cid }); if (s.isHost) broadcastRoster(); });
    room.on('control', MSG.ready, (p) => { dispatch({ type: 'ready', cid: p.cid, ready: p.ready }); if (s.isHost) broadcastRoster(); });
    room.on('control', MSG.roster, (p) => {
      if (s.isHost) return; // we are the authority
      if (lobby.hostCid && p.hostCid !== lobby.hostCid && p.from !== lobby.hostCid) { netlog('ignored roster from non-host', p.from); return; }
      s.lastHostSeen = Date.now();
      lobby = reduce(lobby, { type: 'roster', ...p, now: Date.now() });
      if (lobby.players[cid]) s.mySlot = lobby.players[cid].duck;
      emitLobby();
    });
    room.on('control', MSG.config, (p) => { if (!s.isHost && fromHost(p)) { const { from, ...cfg } = p; dispatch({ type: 'config', config: cfg }); } });
    room.on('control', 'newSeries', () => { if (!s.isHost) dispatch({ type: 'newSeries' }); });
    room.on('control', MSG.handoff, (p) => {
      if (!s.isHost && !fromHost(p)) { netlog('ignored handoff from non-host', p.from); return; }
      dispatch({ type: 'handoff', to: p.to });
      say(lobby.hostCid === cid ? 'You are now the host' : 'Host changed', 'ok');
      if (s.isHost) broadcastRoster();
    });
    room.on('control', MSG.start, (p) => {
      if (s.isHost) { netlog('ignored start while hosting (from', p.from, ')'); return; }
      if (!fromHost(p)) { netlog('ignored start from non-host', p.from); return; }
      if (s.live && s.raceNo === p.raceNo) return;
      netlog('start received', { raceNo: p.raceNo, racers: p.names && p.names.length, inS: Math.round((p.startAt - (clock.samples.length ? clock.toHost(performance.now()) : p.hostNow || p.startAt)) / 100) / 10 });
      beginCountdown(p);
    });
    room.on('control', MSG.over, (p) => { if (s.isHost) { netlog('ignored over while hosting (from', p.from, ')'); return; } if (!fromHost(p)) { netlog('ignored over from non-host', p.from); return; } finishRace(p); });
    room.on('control', MSG.rematch, (p) => { if (!s.isHost && fromHost(p)) { dispatch({ type: 'rematch' }); s.live = null; hooks.onRematch && hooks.onRematch(); } });
    room.on('control', MSG.abort, (p) => { if (!s.isHost && fromHost(p)) hostLost(p.reason || 'Race stopped by the host'); });
    room.on('control', MSG.fallback, (p) => { if (!s.isHost && fromHost(p)) { netlog('fallback (seeded race) from host'); runFallback(p); } });
    room.on('control', 'kick', (p) => { if (!fromHost(p)) return; if (p.cid === cid) { say('Removed by the host', 'error'); leave(); hooks.onAbort && hooks.onAbort('Removed by the host'); } else dispatch({ type: 'forget', cid: p.cid }); });
    for (const kindSig of ['rtc-offer', 'rtc-answer', 'rtc-ice']) room.on('control', kindSig, (p) => { if (p.to === cid) rtc.onSignal(p.from, kindSig, p); });
    // ---- input channel (host consumes)
    room.on('input', MSG.input, (p) => onInputIn(p));
    room.on('input', MSG.ping, (p) => {
      if (!s.isHost) return;
      // during a race the pong rides inside the next frame (no extra fan-out message); in the lobby answer directly
      if (hostRace && (lobby.phase === 'race' || lobby.phase === 'countdown')) pendingPongs.push([p.c, p.t0, performance.now()]);
      else room.send('state', MSG.pong, { c: p.c, t0: p.t0, th: performance.now() });
      seen(p.c);
    });
    // ---- state channel (everyone but the host consumes)
    room.on('state', MSG.pong, (p) => {
      if (p.c !== cid) return;
      clock.addSample(p.t0, performance.now(), p.th);
      s.lastHostSeen = Date.now();
    });
    room.on('state', MSG.frame, (f) => onFrameIn(f, false));
    // legacy separate messages (older hosts)
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
  function onInputIn(p) {
    if (!s.isHost) return;
    s.stats.inputsIn++;
    const slot = slotOf(p.c);
    if (slot >= 0) { inputs[slot] = p.s; inputAt[slot] = Date.now(); }
    seen(p.c);
  }
  function onFrameIn(f, viaRtc) {
    if (s.isHost) return;
    const tick = f.s && f.s[1];
    if (tick !== undefined && tick === lastFrameTick) return; // same frame via both paths
    lastFrameTick = tick;
    const nowP = performance.now();
    s.lastHostSeen = Date.now();
    s.stats.snapsIn++;
    if (viaRtc) s.stats.rtcFramesIn = (s.stats.rtcFramesIn || 0) + 1;
    if (f.p) for (const pg of f.p) if (pg[0] === cid) clock.addSample(pg[1], nowP - Math.max(0, (f.hs || pg[2]) - pg[2]), pg[2]); // pong folded into the frame: discount the time it waited on the host
    const snap = unpackSnapshot(f.s, unpackTarget);
    if (snap && s.live && s.live.applySnapshot) s.live.applySnapshot(snap);
    if (f.e && f.e.length && s.live && s.live.applyEvents) s.live.applyEvents(f.e);
  }
  // guests whose data channel to the host is up leave the Realtime state channel (they no longer count in the
  // broadcast fan-out); if the link drops they re-join it
  let stateSubTimer = null;
  function updateStateSubscription() {
    if (s.isHost || !room || !room.pauseState) return;
    clearTimeout(stateSubTimer);
    stateSubTimer = setTimeout(() => {
      const linked = rtc.hostLinkOpen();
      if (linked && room.stateSubscribed) { room.pauseState(); s.rtcLinked = true; }
      else if (!linked && !room.stateSubscribed) { room.resumeState(); s.rtcLinked = false; }
      else s.rtcLinked = linked;
    }, 600);
  }
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
  function setConfig(cfg) { if (!s.isHost) return; dispatch({ type: 'config', config: cfg }); hostSend(MSG.config, lobby.config); broadcastRoster(); }
  function newSeries() { if (!s.isHost) return; dispatch({ type: 'newSeries' }); hostSend('newSeries', {}); broadcastRoster(); }
  function handoff(to) { if (!s.isHost || !lobby.players[to]) return; hostSend(MSG.handoff, { to }); dispatch({ type: 'handoff', to }); }
  function kick(c) { if (!s.isHost) return; hostSend('kick', { cid: c }); dispatch({ type: 'forget', cid: c }); broadcastRoster(); }

  // ------------------------------------------------------------------ race: host side
  let hostRace = null;
  let lastStartMsg = null;
  let lastOverMsg = null;
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
    const msg = { startAt, seed: raceSeed, names, cids: slotToCid, raceNo, items: lobby.config.items, rule: lobby.config.rule, hostNow: performance.now() };
    lastStartMsg = msg;
    lastOverMsg = null;
    netlog('host starting race', { raceNo, racers: names.length });
    hostSend(MSG.start, msg);
    setTimeout(() => room && hostSend(MSG.start, msg), 400); // belt and braces: a second copy
    beginCountdown(msg, true);
    return true;
  }
  function beginCountdown(msg, asHost = false) {
    dispatch({ type: 'start', startAt: msg.startAt, raceNo: msg.raceNo });
    s.raceNo = msg.raceNo;
    slotToCid = msg.cids;
    s.mySlot = msg.cids.indexOf(cid);
    const humans = new Set(msg.cids.map((_, i) => i));
    const spectators = Object.values(lobby.players).filter((p) => p.online && p.role === ROLES.spectator).length;
    policy = ratePolicy(msg.names.length, spectators);
    s.policy = policy;
    coalescer.minInterval = policy.inputMinMs;
    coalescer.heartbeat = policy.inputHeartbeatMs;
    if (asHost) {
      hostRace = createTrial({ names: msg.names, playerIndex: Math.max(0, s.mySlot), humans, seed: msg.seed });
      for (let i = 0; i < msg.names.length; i++) { inputs[i] = null; inputAt[i] = 0; }
      s.live = hostRace;
      s.startAtLocal = msg.startAt; // host clock == local clock
      lastSnapAt = 0;
      clearInterval(hostTimer);
      hostTimer = setInterval(hostLoop, 16);
    } else {
      s.live = createRemoteRace({ names: msg.names, myIndex: s.mySlot, seed: msg.seed, interpDelay: policy.interpDelay });
      if (!clock.samples.length && msg.hostNow) clock.provisional(msg.hostNow, performance.now() - 40); // assume ~40 ms one-way until pings refine it
      s.startAtLocal = clock.samples.length || msg.hostNow ? clock.toLocal(msg.startAt) : performance.now() + COUNTDOWN_MS - 150;
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
  let lastNudge = 0;
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
    if (now - lastSnapAt >= 1000 / policy.snapHz - 2) {
      lastSnapAt = now;
      const ducks = hostRace.ducks.map((d) => ({ s: d.s, lat: d.lat, v: d.v, flags: (d.state.boosting ? FLAG.boosting : 0) | (d.state.spinning ? FLAG.spinning : 0) | (d.state.airborne ? FLAG.airborne : 0) | (d.finishTime !== null ? FLAG.finished : 0) | (d.autopilot ? FLAG.ai : 0) | (d.state.bonk ? FLAG.bonk : 0) }));
      // ONE broadcast per tick: snapshot + any events + any pongs (fan-out is what the Realtime quota counts)
      const frame = { s: packSnapshot(hostRace.t, snapTick++, ducks) };
      if (evOut.length) { frame.e = evOut; evOut = []; }
      if (pendingPongs.length) { frame.p = pendingPongs.map((pg) => [pg[0], pg[1], pg[2]]); frame.hs = performance.now(); pendingPongs.length = 0; } // hs: host send time, so clients can subtract the queueing delay
      const reached = rtc.sendFrame(frame);
      // anyone racing/watching that the data channels did not reach still needs the broadcast (fan-out only counts those still subscribed)
      let uncovered = 0;
      for (const p of Object.values(lobby.players)) if (p.cid !== cid && p.online && !reached.has(p.cid)) uncovered++;
      if (uncovered > 0 || !reached.size) room.send('state', MSG.frame, frame);
      s.stats.snapsOut++;
      s.stats.rtcPeers = reached.size;
    }
    // finish: everyone home, or 25 s after the first human finishes, or 100 s total
    const humanTimes = slotToCid.map((_, i) => hostRace.race.finishTimes[i]).filter((x) => x !== null);
    const firstHuman = humanTimes.length ? Math.min(...humanTimes) : null;
    if (hostRace.done || (firstHuman !== null && hostRace.t > firstHuman + 25) || hostRace.t > 100) hostFinish();
  }
  const pendingLocal = []; // host: events for the local HUD, delivered on the next render tick
  const pendingPongs = []; // host: pings answered inside the next frame
  let policy = ratePolicy(2);

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
        if (m) {
          const msg = { c: cid, t: Math.round(rt * 1000), s: m.s, b: m.b };
          if (!rtc.sendInput(msg)) room.send('input', MSG.input, msg);
          s.stats.inputsOut++;
        }
      }
      s.live.step(dt, rt, mySteer);
      // results overdue (the `over` broadcast may have been dropped): re-announce ourselves so the host re-sends it
      if (s.live.done && lobby.phase !== 'results' && now - (lastNudge || 0) > 3000) { lastNudge = now; room.send('control', MSG.hello, { cid, name, role, v: PROTOCOL_VERSION, rtc: rtcWanted && rtc.supported }); }
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
    lastOverMsg = msg;
    lastStartMsg = null;
    netlog('host race over', { order: msg.order });
    hostSend(MSG.over, msg);
    setTimeout(() => room && hostSend(MSG.over, msg), 500);
    finishRace(msg);
  }
  function finishRace(msg) {
    if (lobby.phase === 'results' && lobby.results && lobby.results.raceNo === msg.raceNo) return;
    const orderCids = msg.order.map((i) => msg.cids[i]);
    dispatch({ type: 'over', order: orderCids, times: msg.times, raceNo: msg.raceNo });
    if (s.live && s.live.applyResult) s.live.applyResult(msg.order, msg.times);
    const names = msg.cids.map((c) => (lobby.players[c] ? lobby.players[c].name : '—'));
    const st = seriesStandings(lobby);
    const series = lobby.config.bestOf > 1 ? { of: st.of, done: st.done, final: st.final, rows: st.rows.map((r) => ({ slot: msg.cids.indexOf(r.cid), name: lobby.players[r.cid] ? lobby.players[r.cid].name : '—', points: r.points })).filter((r) => r.slot >= 0) } : null;
    hooks.onOver && hooks.onOver({ order: msg.order, times: msg.times, cids: msg.cids, names, rule: msg.rule || lobby.config.rule, picks: pickOrder(msg.order, msg.rule || lobby.config.rule), raceNo: msg.raceNo, series });
  }
  function hostLost(reason) {
    if (lobby.phase === 'lobby') return;
    dispatch({ type: 'rematch' });
    s.live = null;
    hooks.onAbort && hooks.onAbort(reason);
  }
  function rematch() {
    if (!s.isHost) return;
    lastStartMsg = null;
    lastOverMsg = null;
    clearInterval(hostTimer);
    hostSend(MSG.rematch, {});
    dispatch({ type: 'rematch' });
    s.live = null;
    hostRace = null;
    broadcastRoster();
    hooks.onRematch && hooks.onRematch();
  }
  function abortRace(reason = 'Race stopped by the host') {
    if (!s.isHost) return;
    clearInterval(hostTimer);
    hostSend(MSG.abort, { reason });
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
    netlog('host: let the ducks decide (seeded fallback)');
    hostSend(MSG.fallback, msg);
    setTimeout(() => room && hostSend(MSG.fallback, msg), 400);
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
    hostSend(MSG.over, msg);
    finishRace(msg);
  }

  async function leave() {
    rtc.closeAll();
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

  Object.assign(s, { connect, setName, claim, spectate, setReady, setConfig, newSeries, handoff, kick, startRace, tick, raceTime, rematch, abortRace, fallback, fallbackOver, leave, rtc, seriesStandings: () => seriesStandings(lobby) });
  return s;
}
