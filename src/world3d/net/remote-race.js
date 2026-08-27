// Client-side view of a race that is simulated on the host: duck states come from packed snapshots (interpolated
// ~120 ms behind for everyone else) and from local prediction for the player's own duck (blended toward the
// authoritative state). Exposes the same shape as trial.js's live sim ({ ducks[i].state, standings, race,
// drain(), done }) so main.js renders it exactly like a local trial.
import { clamp, lerp } from '../../rng.js';
import { getCourse } from '../course.js';
import { TRIAL, trialLayout } from '../trial.js';
import { SnapshotBuffer, FLAG } from './protocol.js';

export const INTERP_DELAY = 0.12; // default seconds behind the newest host time we render remote ducks at

export function createRemoteRace({ names, myIndex = -1, seed = 1, interpDelay = INTERP_DELAY, course = getCourse() }) {
  const layout = trialLayout(seed, course);
  const L = course.length;
  const F = course.features;
  const count = names.length;
  const buf = new SnapshotBuffer(40);
  const sampled = [];
  const events = [];
  const race = {
    trial: true,
    online: true,
    count,
    v0: TRIAL.v0,
    trackLength: L,
    finishTimes: new Array(count).fill(null),
    order: [],
    events: [],
    stats: names.map(() => ({ hitsTaken: 0, timeLed: 0, itemsUsed: 0 })),
    photoFinish: false,
    close: false,
    margin: 0,
    leadChanges: 0,
    itemsOn: false,
    hotdogs: false,
    projectiles: [],
    windows: names.map(() => []),
  };
  const ducks = names.map((name, i) => ({ i, name, s: F.startS, lat: 0, v: 0, state: { i, pos: null, win: {}, held: null, v0: TRIAL.v0 } }));
  const standings = [];
  // own-duck prediction state
  const me = myIndex >= 0 ? { s: F.startS - (myIndex % 2 ? 1.2 : 0), lat: 0, v: 0, latV: 0, boostUntil: 0, spinUntil: 0, bonkUntil: 0, srv: null, srvT: 0, inited: false } : null;
  let t = 0; // estimated host race time "now" (seconds) — set by setClock each frame
  let leader = -1;

  /** Feed an unpacked snapshot ({t, ducks}) from the host. */
  function applySnapshot(snap) {
    buf.push(snap);
    if (me && snap.ducks[myIndex]) { me.srv = { ...snap.ducks[myIndex] }; me.srvT = snap.t; }
  }
  /** Feed host race events ({type, duck, t, ...}); they are re-emitted through drain() for the local HUD/FX. */
  function applyEvents(list) {
    for (const e of list) {
      events.push(e);
      if (e.type === 'finish') {
        race.finishTimes[e.duck] = e.t;
        if (!race.order.includes(e.duck)) race.order.push(e.duck);
        if (race.order.length === 2) { race.margin = race.finishTimes[race.order[1]] - race.finishTimes[race.order[0]]; race.close = race.margin < 0.35; race.photoFinish = race.margin < 0.08; }
      } else if (e.type === 'lead') race.leadChanges++;
      if (me && e.duck === myIndex) {
        if (e.type === 'use' && e.item === 'bread') me.boostUntil = e.t + TRIAL.padBoost.dur;
        if (e.type === 'stumble' && e.what === 'log') me.spinUntil = e.t + TRIAL.logSpin.dur;
        if (e.type === 'stumble' && e.what === 'bank') me.bonkUntil = e.t + TRIAL.bankBonk.dur;
      }
    }
  }
  /** Authoritative final result from the host ({order:[duck idx], times:{idx:sec}}). */
  function applyResult(order, times) {
    race.order = order.slice();
    for (const [k, v] of Object.entries(times || {})) race.finishTimes[Number(k)] = v;
  }

  /**
   * step(dt, hostNow, mySteer): hostNow = current host race time estimate (s). Remote ducks are sampled at
   * hostNow - INTERP_DELAY; the own duck is predicted at hostNow with local input and eased toward the server.
   */
  function step(dt, hostNow, mySteer) {
    t = hostNow;
    const has = buf.sample(hostNow - interpDelay, sampled);
    for (let i = 0; i < count; i++) {
      const d = ducks[i];
      const src = has && sampled[i] ? sampled[i] : null;
      if (i === myIndex && me) {
        predictMe(dt, mySteer, src);
        d.s = me.s; d.lat = me.lat; d.v = me.v;
      } else if (src) { d.s = src.s; d.lat = src.lat; d.v = src.v; }
      const flags = i === myIndex && me && me.srv ? me.srv.flags : src ? src.flags : 0;
      const st = d.state;
      st.t = t;
      st.s = d.s;
      st.lat = d.lat;
      st.v = d.v;
      st.finished = race.finishTimes[i] !== null || !!(flags & FLAG.finished);
      const w = st.win;
      w.boost = flags & FLAG.boosting ? { kind: 'boost', t0: t - 0.2, t1: t + 0.2 } : null;
      w.spin = flags & FLAG.spinning ? (w.spin && w.spin.t1 > t ? w.spin : { kind: 'spin', t0: t, t1: t + TRIAL.logSpin.dur }) : null;
      w.stumble = flags & FLAG.bonk ? { kind: 'stumble', t0: t - 0.1, t1: t + 0.3, what: 'bank' } : null;
      w.burst = w.shield = w.star = w.mud = w.wobble = null;
      st.boosting = !!w.boost;
      st.star = false;
      st.spinning = !!w.spin;
      st.autopilot = !!(flags & FLAG.ai);
      st.held = null;
    }
    // standings from current positions (finished ducks by finish time)
    standings.length = 0;
    for (const d of ducks) standings.push({ i: d.i, s: race.finishTimes[d.i] !== null ? L + 1e3 - race.finishTimes[d.i] : d.s });
    standings.sort((a, b) => b.s - a.s || a.i - b.i);
    standings.forEach((row, k) => { ducks[row.i].state.rank = k; });
    leader = standings.length ? standings[0].i : -1;
  }

  function predictMe(dt, steer, src) {
    if (!me.inited) {
      if (me.srv) { me.s = me.srv.s; me.lat = me.srv.lat; me.v = me.srv.v; me.inited = true; }
      else if (src) { me.s = src.s; me.lat = src.lat; me.v = src.v; me.inited = true; }
    }
    if (race.finishTimes[myIndex] !== null) {
      // finished: just follow the server
      if (me.srv) { me.s = lerp(me.s, me.srv.s + me.srv.v * Math.max(0, t - me.srvT), dt * 4); me.lat = lerp(me.lat, me.srv.lat, dt * 4); me.v = me.srv.v; }
      return;
    }
    // same physics as the host sim (trial.js) for one duck
    const half = course.widthAt(me.s) / 2 - TRIAL.edgeMargin;
    let target = TRIAL.v0;
    if (t < me.boostUntil) target *= 1 + TRIAL.padBoost.amp;
    if (t < me.spinUntil) target *= TRIAL.logSpin.slow;
    if (t < me.bonkUntil) target *= TRIAL.bankBonk.slow;
    const sec = course.sectionIdAt(me.s);
    if (sec === 'tunnel') target *= 1.05;
    me.v = t < 0 ? 0 : lerp(me.v, target, dt * (me.v < target ? 1.6 : 3));
    me.latV = lerp(me.latV, clamp(steer, -1, 1) * TRIAL.steerRate, dt * 5);
    const airborne = course.hopAt(me.s) > 0.02;
    if (!airborne) me.lat += me.latV * dt;
    if (Math.abs(me.lat) > half) { me.lat = Math.sign(me.lat) * half; me.latV *= -0.4; }
    const prevS = me.s;
    if (t >= 0) me.s += me.v * dt;
    if (!airborne) {
      // predict pads/logs locally so the boost/spin feels instant; the host's events confirm (or not) a beat later
      for (const p of layout.pads) if (p.s > prevS && p.s <= me.s && Math.abs(me.lat - p.lat) < p.r) me.boostUntil = Math.max(me.boostUntil, t + TRIAL.padBoost.dur);
      for (const o of layout.logs) if (o.s > prevS && o.s <= me.s && Math.abs(me.lat - o.lat) < o.len * 0.5 + 0.35 && t > me.spinUntil) me.spinUntil = t + TRIAL.logSpin.dur;
    }
    // reconcile toward the authoritative state extrapolated to "now"
    if (me.srv) {
      const age = Math.max(0, t - me.srvT);
      const srvS = me.srv.s + me.srv.v * Math.min(age, 0.4);
      const errS = srvS - me.s;
      const errL = me.srv.lat - me.lat; // lateral: server is `age` old; our input since then is legitimately newer, so correct gently
      if (Math.abs(errS) > 12 || Math.abs(errL) > 8) { me.s = srvS; me.lat = me.srv.lat; } // way off (e.g. after a stall): snap
      else { me.s += errS * Math.min(1, dt * 3); me.lat += errL * Math.min(1, dt * 1.2); }
    }
  }

  return {
    race,
    ducks,
    standings,
    pads: layout.pads,
    logs: layout.logs,
    get t() { return t; },
    get leader() { return Math.max(0, leader); },
    get done() { return race.order.length === count; },
    get latestSnapT() { return buf.latestT; },
    playerIndex: myIndex,
    myIndex,
    applySnapshot,
    applyEvents,
    applyResult,
    step,
    drain() { const out = events.splice(0, events.length); race.events.push(...out); return out; },
  };
}
