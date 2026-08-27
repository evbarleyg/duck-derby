// Wire protocol for the online Grand Prix: message names, compact snapshot packing, input coalescing.
// Everything here is pure (no THREE, no network) so it is unit-testable and shared by host and clients.

export const PROTOCOL_VERSION = 1;

// channel suffixes (room:<CODE>, room:<CODE>:in, room:<CODE>:out)
export const CH = { control: '', input: ':in', state: ':out' };

// message types
export const MSG = {
  // control channel (everyone <-> everyone)
  hello: 'hello', // {cid, name, v}
  claim: 'claim', // {cid, duck}            player picks a duck slot
  ready: 'ready', // {cid, ready}
  config: 'config', // {rule, items, bestOf, names[]}   host -> all (authoritative lobby config + roster order)
  roster: 'roster', // {players:[{cid,name,duck,ready,role}], hostCid}  host -> all, the converged view
  handoff: 'handoff', // {to}                  host -> all
  start: 'start', // {startAt, seed, names, drivers, raceNo}  host -> all (host time ms)
  over: 'over', // {order, times, raceNo}   host -> all
  rematch: 'rematch', // {}                  host -> all
  fallback: 'fallback', // {names, seed, startAt, rule}  host -> all: "let the ducks decide"
  abort: 'abort', // {reason}                host -> all
  // input channel (players -> host)
  input: 'i', // {c: cid, t: hostTime, s: steer(-1..1 quantised), b: buttons bitfield}
  ping: 'ping', // {c, t0}
  // state channel (host -> all)
  snap: 's', // packed snapshot (see packSnapshot)
  pong: 'pong', // {c, t0, th}
  ev: 'ev', // {list:[event,...]} race events (pickup/hit/finish...) stamped with host race time
};

// duck state flags packed into one small int
export const FLAG = { boosting: 1, spinning: 2, airborne: 4, finished: 8, ai: 16, bonk: 32 };

/**
 * Pack a snapshot. ducks: [{ s, lat, v, flags }], t = host race time (s), tick = snapshot counter.
 * Layout: [version, tick, t*1000|0, n, s0*10, lat0*100, v0*10, f0, s1*10, ...] -- all integers, JSON-friendly
 * (~6-7 bytes per number as text; 12 ducks ~ 350 B).
 */
export function packSnapshot(t, tick, ducks) {
  const out = new Array(4 + ducks.length * 4);
  out[0] = PROTOCOL_VERSION;
  out[1] = tick | 0;
  out[2] = Math.round(t * 1000);
  out[3] = ducks.length;
  let k = 4;
  for (const d of ducks) {
    out[k++] = Math.round(d.s * 10);
    out[k++] = Math.round(d.lat * 100);
    out[k++] = Math.round(d.v * 10);
    out[k++] = d.flags | 0;
  }
  return out;
}

/** Inverse of packSnapshot → { t, tick, ducks:[{s, lat, v, flags}] } (reuses `into.ducks` objects when given). */
export function unpackSnapshot(arr, into = null) {
  if (!Array.isArray(arr) || arr[0] !== PROTOCOL_VERSION) return null;
  const n = arr[3] | 0;
  const res = into || { t: 0, tick: 0, ducks: [] };
  res.tick = arr[1];
  res.t = arr[2] / 1000;
  while (res.ducks.length < n) res.ducks.push({ s: 0, lat: 0, v: 0, flags: 0 });
  res.ducks.length = n;
  let k = 4;
  for (let i = 0; i < n; i++) {
    const d = res.ducks[i];
    d.s = arr[k++] / 10;
    d.lat = arr[k++] / 100;
    d.v = arr[k++] / 10;
    d.flags = arr[k++] | 0;
  }
  return res;
}

/**
 * Input coalescing: call `offer(steer, buttons, nowMs)` every frame; it returns a message to send only when the
 * input changed by more than `eps`, a button changed, or the heartbeat interval elapsed -- and never more often
 * than `minInterval` (10 Hz by default). Steer is quantised to 2 decimals on the wire.
 */
export class InputCoalescer {
  constructor({ eps = 0.04, minInterval = 100, heartbeat = 250 } = {}) {
    this.eps = eps;
    this.minInterval = minInterval;
    this.heartbeat = heartbeat;
    this.lastSentAt = -Infinity;
    this.lastSteer = null;
    this.lastButtons = 0;
  }
  offer(steer, buttons, nowMs) {
    const q = Math.round(Math.max(-1, Math.min(1, steer)) * 100) / 100;
    const since = nowMs - this.lastSentAt;
    if (since < this.minInterval) return null;
    const changed = this.lastSteer === null || Math.abs(q - this.lastSteer) > this.eps || buttons !== this.lastButtons;
    if (!changed && since < this.heartbeat) return null;
    this.lastSentAt = nowMs;
    this.lastSteer = q;
    this.lastButtons = buttons;
    return { s: q, b: buttons | 0 };
  }
}

/**
 * Snapshot interpolation buffer for remote ducks: push({t, ducks}) as snapshots arrive (host race time), then
 * sample(renderT, out) interpolates between the two snapshots around renderT (or extrapolates up to 250 ms).
 */
export class SnapshotBuffer {
  constructor(max = 30) {
    this.snaps = [];
    this.max = max;
  }
  push(snap) {
    // copy (the unpack target is reused by the caller)
    const copy = { t: snap.t, tick: snap.tick, ducks: snap.ducks.map((d) => ({ s: d.s, lat: d.lat, v: d.v, flags: d.flags })) };
    const arr = this.snaps;
    if (arr.length && copy.t <= arr[arr.length - 1].t) {
      // out of order: insert in place (rare)
      let i = arr.length - 1;
      while (i >= 0 && arr[i].t > copy.t) i--;
      if (i >= 0 && arr[i].t === copy.t) return;
      arr.splice(i + 1, 0, copy);
    } else arr.push(copy);
    while (arr.length > this.max) arr.shift();
  }
  get latestT() { return this.snaps.length ? this.snaps[this.snaps.length - 1].t : -Infinity; }
  /** Interpolated duck states at race time t → writes into out[] ({s, lat, v, flags}); returns false if empty. */
  sample(t, out) {
    const arr = this.snaps;
    if (!arr.length) return false;
    let b = arr.length - 1;
    while (b > 0 && arr[b - 1].t > t) b--;
    const B = arr[b];
    const A = b > 0 ? arr[b - 1] : null;
    const n = B.ducks.length;
    while (out.length < n) out.push({ s: 0, lat: 0, v: 0, flags: 0 });
    out.length = n;
    if (!A || t >= B.t) {
      // newest snapshot is older than t: extrapolate along s with the last speed (capped)
      const dt = Math.min(0.25, Math.max(0, t - B.t));
      for (let i = 0; i < n; i++) {
        const d = B.ducks[i];
        out[i].s = d.s + ((d.flags & FLAG.finished) ? Math.min(d.v, 8) : d.v) * dt;
        out[i].lat = d.lat;
        out[i].v = d.v;
        out[i].flags = d.flags;
      }
      return true;
    }
    const f = B.t > A.t ? Math.max(0, Math.min(1, (t - A.t) / (B.t - A.t))) : 1;
    for (let i = 0; i < n; i++) {
      const a = A.ducks[i] || B.ducks[i];
      const d = B.ducks[i];
      out[i].s = a.s + (d.s - a.s) * f;
      out[i].lat = a.lat + (d.lat - a.lat) * f;
      out[i].v = a.v + (d.v - a.v) * f;
      out[i].flags = f < 0.5 ? a.flags : d.flags;
    }
    return true;
  }
}
