// Host-clock offset estimation from ping/pong samples.
// offset = hostTime - localTime. Each sample: local send time t0, local receive time t1, host time th (stamped
// when the host handled the ping). Estimate per sample: th - (t0 + t1) / 2, weight by low RTT.
export class ClockSync {
  constructor() {
    this.samples = []; // { rtt, offset }
    this.offset = 0;
    this.rtt = 0;
    this.ready = false;
  }
  /** Add one ping/pong measurement (all in ms). Returns the current estimate. */
  addSample(t0, t1, th) {
    const rtt = Math.max(0, t1 - t0);
    const offset = th - (t0 + t1) / 2;
    this.samples.push({ rtt, offset });
    if (this.samples.length > 16) this.samples.shift();
    // use the median offset of the best (lowest-RTT) half: robust to one slow round trip
    const best = this.samples.slice().sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    const offs = best.map((s) => s.offset).sort((a, b) => a - b);
    this.offset = offs[Math.floor(offs.length / 2)];
    const rtts = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
    this.rtt = rtts[Math.floor(rtts.length / 2)];
    this.ready = this.samples.length >= 3;
    return this.offset;
  }
  /** Convert a local timestamp (ms) to host time. */
  toHost(localMs) { return localMs + this.offset; }
  /** Convert a host timestamp (ms) to local time. */
  toLocal(hostMs) { return hostMs - this.offset; }
}
