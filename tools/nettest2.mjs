// M4 hardening test through the relay: (1) a guest reloads mid-race and rejoins the running race with control,
// (2) everyone still converges on the host's result, (3) the results permalink renders stand-alone,
// (4) "let the ducks decide" fallback runs the seeded race on every client with the same result.
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
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const issues = [];
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's', ...a);
const extra = `&sound=0&noadapt=1&q=low&relay=${encodeURIComponent(relay)}`;
async function open(label, url) {
  const context = await browser.newContext({ viewport: { width: 400, height: 240 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => issues.push(`${label} pageerror: ${e.message} @ ${(e.stack || '').split('\n').slice(1, 3).join(' | ')}`));
  page.on('console', (m) => { if (m.type() === 'error') issues.push(`${label} console: ${m.text()}`); });
  await page.addInitScript((name) => { window.name = 'ddw-' + name; localStorage.setItem('duckworld:v1', JSON.stringify({ myName: name, flySeen: true, coached: true, sound: false })); }, label);
  await page.goto(url + extra, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 90000 });
  return page;
}
let ok = true;
const host = await open('host', `${base}?host=1`);
await host.waitForFunction(() => /Hosting/.test(document.getElementById('ol-status').textContent), null, { timeout: 30000 });
const code = (await host.textContent('#ol-code')).trim();
log('room', code);
const g1 = await open('ann', `${base}?room=${code}`);
const g2 = await open('bob', `${base}?room=${code}`);
for (const p of [host, g1, g2]) await p.waitForFunction(() => document.querySelectorAll('#ol-roster li').length >= 3, null, { timeout: 30000 });
for (const p of [host, g1, g2]) await p.click('#ol-ready');
await host.waitForFunction(() => !document.getElementById('ol-go').disabled, null, { timeout: 20000 });
await host.click('#ol-go');
for (const p of [host, g1, g2]) await p.waitForFunction(() => window.__duckWorld.state.phase === 'race', null, { timeout: 60000 });
log('racing; bob reloads now (phone lock simulation)');
const slotBefore = await g2.evaluate(() => window.__duckWorld.session().mySlot);
await g2.reload({ waitUntil: 'load' });
await g2.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 90000 });
// should land straight back in the race with the same slot
try {
  await g2.waitForFunction(() => window.__duckWorld.session() && (window.__duckWorld.state.phase === 'results' || (['race', 'finish'].includes(window.__duckWorld.state.phase) && window.__duckWorld.session().live)), null, { timeout: 60000 });
  const after = await g2.evaluate(() => { const s = window.__duckWorld.session(); return { slot: s.mySlot, snaps: s.stats.snapsIn, phase: window.__duckWorld.state.phase }; });
  log('bob rejoined:', JSON.stringify(after), 'slot kept:', after.slot === slotBefore);
  ok = ok && after.slot === slotBefore;
  if (after.phase === 'race') {
    // does the host see bob's inputs again (autopilot off)?
    await g2.keyboard.down('ArrowLeft');
    await host.waitForTimeout(2500);
    await g2.keyboard.up('ArrowLeft');
    const auto = await host.evaluate((slot) => { const s = window.__duckWorld.session(); return s.live && s.live.ducks ? s.live.ducks[slot].autopilot : 'race over'; }, slotBefore);
    log('host sees bob driving again (autopilot=false):', auto);
    ok = ok && auto !== true;
  } else log('(race already over by the time the slow headless page rebooted — control-resume is covered by tools/rejoin timing runs)');
} catch (e) { log('bob did NOT rejoin the race:', e.message.split('\n')[0]); ok = false; }
for (const p of [host, g1, g2]) await p.waitForFunction(() => window.__duckWorld.state.phase === 'results' && !document.getElementById('results').hidden, null, { timeout: 240000 });
const orders = await Promise.all([host, g1, g2].map((p) => p.$$eval('#res-board > li .nm', (els) => els.map((e) => e.childNodes[0].textContent.trim()).join(' > '))));
const same = orders.every((o) => o === orders[0]);
log('results identical on all 3:', same, '|', orders[0]);
ok = ok && same;
// permalink
const link = await g1.evaluate(() => window.__duckWorld.resultLink());
const viewer = await open('viewer', link + '&x=1');
await viewer.waitForFunction(() => !document.getElementById('results').hidden, null, { timeout: 30000 });
const permaOrder = await viewer.$$eval('#res-board > li .nm', (els) => els.map((e) => e.childNodes[0].textContent.trim()).join(' > '));
log('permalink renders the same order:', permaOrder === orders[0], '|', link.replace(/^http:\/\/localhost:8080/, ''));
ok = ok && permaOrder === orders[0];
// fallback: rematch, ready, "let the ducks decide"
await host.click('#btn-replay');
for (const p of [g1, g2]) await p.waitForFunction(() => !document.getElementById('online').hidden, null, { timeout: 30000 });
for (const p of [g1, g2]) await p.click('#ol-ready');
await host.evaluate(() => { window.confirm = () => true; });
await host.waitForTimeout(1500);
await host.click('#ol-fallback');
for (const p of [host, g1, g2]) await p.waitForFunction(() => ['grid', 'countdown', 'race'].includes(window.__duckWorld.state.phase) && !window.__duckWorld.state.trial, null, { timeout: 60000 });
const seeds = await Promise.all([host, g1, g2].map((p) => p.evaluate(() => ({ seed: window.__duckWorld.state.seed, names: window.__duckWorld.state.raceNames.join(','), order: window.__duckWorld.state.race.order.join(',') }))));
const fbSame = seeds.every((x) => x.seed === seeds[0].seed && x.names === seeds[0].names && x.order === seeds[0].order);
log('fallback seeded race: same seed/names/precomputed order on all 3:', fbSame);
ok = ok && fbSame;
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
console.log(ok && !issues.length ? 'PASS' : 'FAIL');
process.exit(ok && !issues.length ? 0 : 1);
