import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packSnapshot, unpackSnapshot, InputCoalescer, SnapshotBuffer, FLAG, PROTOCOL_VERSION, ratePolicy, messageBudget } from '../src/world3d/net/protocol.js';
import { makeRoomCode, normalizeRoomCode, CODE_ALPHABET, makeClientId } from '../src/world3d/net/codes.js';
import { ClockSync } from '../src/world3d/net/clock.js';

test('snapshot pack/unpack round-trips within quantisation', () => {
  const ducks = Array.from({ length: 12 }, (_, i) => ({ s: 123.456 + i * 7.31, lat: -4.567 + i, v: 22.94 + i * 0.1, flags: i % 2 ? FLAG.boosting | FLAG.airborne : 0 }));
  const packed = packSnapshot(31.4159, 77, ducks);
  assert.equal(packed[0], PROTOCOL_VERSION);
  assert.ok(packed.every((x) => Number.isInteger(x)), 'all integers on the wire');
  assert.ok(JSON.stringify(packed).length < 450, 'compact for 12 ducks: ' + JSON.stringify(packed).length);
  const u = unpackSnapshot(packed);
  assert.equal(u.tick, 77);
  assert.ok(Math.abs(u.t - 31.416) < 1e-9);
  assert.equal(u.ducks.length, 12);
  u.ducks.forEach((d, i) => {
    assert.ok(Math.abs(d.s - ducks[i].s) <= 0.05);
    assert.ok(Math.abs(d.lat - ducks[i].lat) <= 0.005);
    assert.ok(Math.abs(d.v - ducks[i].v) <= 0.05);
    assert.equal(d.flags, ducks[i].flags);
  });
  // reuse target object
  const again = unpackSnapshot(packSnapshot(1, 1, ducks.slice(0, 3)), u);
  assert.equal(again, u);
  assert.equal(u.ducks.length, 3);
  assert.equal(unpackSnapshot([99, 1, 2, 0]), null, 'rejects other protocol versions');
});

test('input coalescer: ≤10 Hz, sends on change, heartbeats when idle', () => {
  const c = new InputCoalescer({ minInterval: 100, heartbeat: 250 });
  const sent = [];
  let steer = 0;
  for (let ms = 0; ms <= 3000; ms += 16) {
    if (ms > 1000 && ms < 1500) steer = Math.sin(ms / 80); // wiggling
    const m = c.offer(steer, 0, ms);
    if (m) sent.push({ ms, ...m });
  }
  // never closer than 100 ms
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].ms - sent[i - 1].ms >= 100 - 1e-9);
  // idle first second: only heartbeats (~4), wiggle: ~5 in 0.5 s, idle after: heartbeats
  const idle1 = sent.filter((s) => s.ms <= 1000).length;
  const wig = sent.filter((s) => s.ms > 1000 && s.ms < 1500).length;
  assert.ok(idle1 >= 3 && idle1 <= 5, 'idle heartbeats ' + idle1);
  assert.ok(wig >= 4 && wig <= 6, 'change-driven sends ' + wig);
  assert.ok(sent.every((s) => Math.abs(s.s) <= 1 && Number.isInteger(s.s * 100 + 0) || Math.abs(Math.round(s.s * 100) - s.s * 100) < 1e-9));
});

test('snapshot buffer interpolates between snapshots and extrapolates a little past the newest', () => {
  const buf = new SnapshotBuffer();
  const mk = (t, s) => ({ t, tick: 0, ducks: [{ s, lat: t, v: 20, flags: 0 }, { s: s + 5, lat: 0, v: 20, flags: FLAG.finished }] });
  buf.push(mk(1.0, 100));
  buf.push(mk(1.1, 102));
  buf.push(mk(1.2, 104));
  const out = [];
  assert.ok(buf.sample(1.15, out));
  assert.ok(Math.abs(out[0].s - 103) < 1e-9);
  assert.ok(Math.abs(out[0].lat - 1.15) < 1e-9);
  buf.sample(1.3, out); // 0.1 s past newest -> extrapolate with v=20 -> 106
  assert.ok(Math.abs(out[0].s - 106) < 1e-9);
  buf.sample(5, out); // capped at 0.25 s
  assert.ok(Math.abs(out[0].s - (104 + 20 * 0.25)) < 1e-9);
  // out-of-order insert keeps order
  buf.push(mk(1.05, 101));
  buf.sample(1.075, out);
  assert.ok(Math.abs(out[0].s - 101.5) < 1e-9);
});

test('room codes: alphabet has no look-alikes, normaliser accepts sloppy input and rejects junk', () => {
  for (const bad of ['0', 'O', '1', 'I', 'L', '5', 'S', '2', 'Z', '8', 'B', 'U', 'V']) assert.ok(!CODE_ALPHABET.includes(bad), bad);
  let i = 0;
  const seq = [0.01, 0.5, 0.99, 0.3];
  const code = makeRoomCode(() => seq[i++ % 4]);
  assert.equal(code.length, 4);
  assert.equal(normalizeRoomCode(' ' + code.toLowerCase().split('').join('-') + ' '), code);
  assert.equal(normalizeRoomCode('ABC'), null);
  assert.equal(normalizeRoomCode('ABCDE'), null);
  assert.equal(normalizeRoomCode('AB1D'), null); // 1 -> I, not in alphabet
  assert.equal(normalizeRoomCode(null), null);
  assert.equal(makeClientId().length, 10);
});

test('clock sync converges on the true offset despite one slow round trip', () => {
  const cs = new ClockSync();
  const trueOffset = 12345; // host clock ahead by 12.345 s
  const rtts = [40, 42, 300, 41, 39, 44];
  let now = 1000;
  for (const rtt of rtts) {
    const t0 = now;
    const th = t0 + rtt / 2 + trueOffset; // host stamps at the midpoint
    const t1 = t0 + rtt;
    cs.addSample(t0, t1, th);
    now += 500;
  }
  assert.ok(cs.ready);
  assert.ok(Math.abs(cs.offset - trueOffset) < 2, 'offset ' + cs.offset);
  assert.ok(Math.abs(cs.toLocal(cs.toHost(777)) - 777) < 1e-9);
  assert.ok(cs.rtt >= 40 && cs.rtt <= 44);
});

test('message budget: rates step down with room size and 12 racers + a TV stay under ~250 deliveries/s', () => {
  assert.equal(ratePolicy(3).snapHz, 12);
  assert.equal(ratePolicy(8).snapHz, 10);
  assert.equal(ratePolicy(12).snapHz, 8);
  assert.ok(ratePolicy(12).interpDelay > ratePolicy(3).interpDelay);
  const b12 = messageBudget(12, 1); // 12 racers incl. host + one spectator screen
  assert.ok(b12.perSecond < 250, JSON.stringify(b12));
  assert.ok(b12.detail.frames === 8 * 12, 'fan-out dominates: 8 Hz x 12 subscribers');
  const b4 = messageBudget(4);
  assert.ok(b4.perSecond < 80, JSON.stringify(b4));
});
