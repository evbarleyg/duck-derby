// M5 load test: one host + N bot players as lightweight Node clients (no WebGL) speaking the real protocol through
// the real session code (src/world3d/net/session.js), over either transport:
//   node tools/loadtest.mjs relay 12 180      -> 12 bots, 180 s session via tools/relay.mjs (ws://localhost:8787)
//   node tools/loadtest.mjs supabase 12 180   -> the same through the provisioned Supabase project (needs egress)
// Bots steer with a wandering input at the full 10 Hz budget. Reports: delivered snapshot rate per bot, input rate at
// the host, RTT distribution, result convergence (every bot got the same canonical order), and host heap growth.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [kind = 'relay', botsArg = '12', secsArg = '150', relayUrl = 'ws://localhost:8787'] = process.argv.slice(2);
if (typeof WebSocket === 'undefined') { console.error('Node >= 22 is required (global WebSocket client)'); process.exit(2); }
const BOTS = Number(botsArg);
const SECS = Number(secsArg);
// browser shims for the session module under Node
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); } };
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
if (kind === 'supabase') vm.runInThisContext(fs.readFileSync(path.join(root, 'vendor/supabase/supabase.js'), 'utf8') + '\nglobalThis.supabase = supabase;');
const { createSession } = await import(path.join(root, 'src/world3d/net/session.js'));
const { makeRoomCode } = await import(path.join(root, 'src/world3d/net/codes.js'));
const code = makeRoomCode();
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's', ...a);
log(`transport=${kind} room=${code} bots=${BOTS} duration=${SECS}s`);
const results = new Map(); // name -> order string
const overs = [];
function mk(role, name) {
  window.name = 'ddw-' + name; // distinct client ids per bot
  return createSession({
    role, code, name, kind, relayUrl,
    hooks: {
      onOver: ({ order, names }) => { results.set(name, order.join(',')); overs.push(Date.now()); },
      onAbort: (r) => log(name, 'ABORT', r),
      onStatus: () => {},
    },
  });
}
const host = mk('host', 'host');
await host.connect();
const bots = [];
for (let i = 0; i < BOTS; i++) { const b = mk('guest', 'bot' + (i + 1)); await b.connect(); bots.push(b); }
// wait for roster convergence on the host
const deadline = Date.now() + 20000;
while (Object.keys(host.lobby.players).length < BOTS + 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
log('host roster size', Object.keys(host.lobby.players).length);
// ready flags propagate over the real network; wait for the host to see them (the lobby UI gates GO
// on the same condition) instead of sleeping a fixed interval
const waitAllReady = async (ms) => {
  const d = Date.now() + ms;
  while (!Object.values(host.lobby.players).every((p) => p.ready) && Date.now() < d) await new Promise((r) => setTimeout(r, 200));
};
for (const b of bots) b.setReady(true);
host.setReady(true);
await waitAllReady(15000);
const mem0 = process.memoryUsage().heapUsed;
let races = 0;
const raceStats = [];
const endAt = Date.now() + SECS * 1000;
while (Date.now() < endAt) {
  if (!host.startRace()) { log('cannot start (not all ready?)', JSON.stringify(Object.values(host.lobby.players).map((p) => [p.name, p.ready, p.online]))); break; }
  races++;
  const raceStart = Date.now();
  // drive: each bot ticks at ~30 Hz with a wandering steer; host ticks too (its own duck idles)
  const timers = bots.map((b, i) => setInterval(() => { const tt = (Date.now() - raceStart) / 1000; b.tick(1 / 30, Math.sin(tt * (0.7 + i * 0.05) + i)); }, 33));
  const hostTimer = setInterval(() => host.tick(1 / 30, 0), 33);
  // wait for over on the host
  while (host.lobby.phase !== 'results' && Date.now() - raceStart < 130000) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1500)); // let the over message reach every bot
  timers.forEach(clearInterval);
  clearInterval(hostTimer);
  const dur = (Date.now() - raceStart) / 1000;
  const snapsIn = bots.map((b) => b.stats.snapsIn);
  const rtts = bots.map((b) => Math.round(b.clock.rtt || 0)).sort((a, b) => a - b);
  const orders = bots.map((b) => results.get(b.lobby.players[b.cid] ? b.lobby.players[b.cid].name : '') || null);
  const hostOrder = results.get('host');
  const converged = orders.every((o) => o === hostOrder);
  raceStats.push({ race: races, seconds: +dur.toFixed(1), hostInputsIn: host.stats.inputsIn, hostSnapsOut: host.stats.snapsOut, botSnapsInMin: Math.min(...snapsIn), botSnapsInMax: Math.max(...snapsIn), rttP50: rtts[Math.floor(rtts.length / 2)], rttMax: rtts[rtts.length - 1], converged });
  log('race', races, JSON.stringify(raceStats[raceStats.length - 1]));
  // reset counters, rematch, ready up again
  host.stats.inputsIn = 0; host.stats.snapsOut = 0; for (const b of bots) b.stats.snapsIn = 0;
  results.clear();
  host.rematch();
  await new Promise((r) => setTimeout(r, 800));
  for (const b of bots) b.setReady(true);
  host.setReady(true);
  await waitAllReady(15000);
}
const mem1 = process.memoryUsage().heapUsed;
console.log('\nSUMMARY', JSON.stringify({ transport: kind, bots: BOTS, races, perRace: raceStats, heapMB: { start: +(mem0 / 1e6).toFixed(1), end: +(mem1 / 1e6).toFixed(1) }, allConverged: raceStats.every((r) => r.converged) }, null, 1));
await Promise.all([host, ...bots].map((s) => s.leave()));
process.exit(raceStats.length && raceStats.every((r) => r.converged) ? 0 : 1);
