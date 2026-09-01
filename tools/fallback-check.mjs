// Regression for the live failure of 2026-08-31: "Let the ducks decide" (seeded fallback) froze every screen.
// Host + 2 guests through the relay; guest B runs with a wildly different page-uptime clock (performance.now offset)
// and a skewed wall clock. Assert: after the host presses the fallback, ALL clients leave the start (t advances),
// reach results, and show the same draft order; the lobby converges to `results` (rematch works).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [relay = 'ws://localhost:8787', base = 'http://localhost:8080/world.html'] = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const R = encodeURIComponent(relay);
const issues = [];
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's', ...a);
async function open(label, url, { perfSkewMs = 0, dateSkewMs = 0 } = {}) {
  const ctx = await b.newContext({ viewport: { width: 400, height: 240 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => issues.push(`${label} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') issues.push(`${label} console: ${m.text()}`); if (/\[net\].*(fallback|clamp)/.test(m.text())) console.log(`   ${label} ${m.text()}`); });
  await p.addInitScript(([name, ps, ds]) => {
    window.name = 'ddw-' + name;
    localStorage.setItem('duckworld:v1', JSON.stringify({ myName: name, flySeen: true, coached: true, sound: false }));
    if (ps) { const o = performance.now.bind(performance); performance.now = () => o() + ps; }
    if (ds) { const d = Date.now.bind(Date); Date.now = () => d() + ds; }
  }, [label, perfSkewMs, dateSkewMs]);
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 90000 });
  return p;
}
const host = await open('host', `${base}?host=1&relay=${R}&sound=0&noadapt=1&q=low`);
await host.waitForFunction(() => /Hosting/.test(document.getElementById('ol-status').textContent), null, { timeout: 30000 });
const code = (await host.textContent('#ol-code')).trim();
const gA = await open('ann', `${base}?room=${code}&relay=${R}&sound=0&noadapt=1&q=low`);
const gB = await open('bob', `${base}?room=${code}&relay=${R}&sound=0&noadapt=1&q=low`, { perfSkewMs: 37 * 60 * 1000, dateSkewMs: -2500 }); // 37 min more "uptime", wall clock 2.5 s slow
for (const p of [host, gA, gB]) await p.waitForFunction(() => document.querySelectorAll('#ol-roster li').length >= 3, null, { timeout: 30000 });
log('room', code, 'with 3; pressing the fallback');
await host.evaluate(() => { window.confirm = () => true; });
await host.click('#ol-fallback');
const all = [host, gA, gB];
// everyone must actually leave the line
for (const [i, p] of all.entries()) {
  try {
    await p.waitForFunction(() => window.__duckWorld.state.phase === 'race' && window.__duckWorld.state.t > 3, null, { timeout: 60000 });
  } catch { issues.push(`${['host', 'ann', 'bob'][i]}: race never advanced past the start (phase=${await p.evaluate(() => window.__duckWorld.state.phase)}, t=${await p.evaluate(() => window.__duckWorld.state.t)})`); }
}
log('all three left the start line');
for (const p of all) await p.waitForFunction(() => window.__duckWorld.state.phase === 'results' && !document.getElementById('results').hidden, null, { timeout: 240000 });
const orders = await Promise.all(all.map((p) => p.$$eval('#res-board > li .nm', (els) => els.map((e) => e.childNodes[0].textContent.trim()).join(' > '))));
const same = orders.every((o) => o === orders[0]);
log('results on all three, identical:', same, '|', orders[0]);
const lobbyPhases = await Promise.all(all.map((p) => p.evaluate(() => window.__duckWorld.session().lobby.phase)));
log('lobby phases:', lobbyPhases.join(','));
await host.click('#btn-replay');
for (const p of [gA, gB]) await p.waitForFunction(() => !document.getElementById('online').hidden, null, { timeout: 30000 });
log('rematch returned guests to the lobby');
await b.close();
const ok = same && !issues.length && lobbyPhases.every((x) => x === 'results');
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
