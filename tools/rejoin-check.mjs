// Focused check of the mid-race reconnect path: host + 1 guest through the relay; the guest reloads right after GO
// and must land back in the SAME race (same slot) with control (host sees autopilot switch off after input).
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
const extra = `&sound=0&noadapt=1&q=low&relay=${encodeURIComponent(relay)}`;
const issues = [];
async function open(label, url) {
  const ctx = await b.newContext({ viewport: { width: 360, height: 200 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => issues.push(label + ' ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') issues.push(label + ' ' + m.text()); });
  await p.addInitScript((name) => { window.name = 'ddw-' + name; localStorage.setItem('duckworld:v1', JSON.stringify({ myName: name, flySeen: true, coached: true, sound: false })); }, label);
  await p.goto(url + extra, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 90000 });
  return p;
}
const host = await open('host', `${base}?host=1`);
await host.waitForFunction(() => /Hosting/.test(document.getElementById('ol-status').textContent), null, { timeout: 30000 });
const code = (await host.textContent('#ol-code')).trim();
const g = await open('bob', `${base}?room=${code}`);
await g.waitForFunction(() => document.querySelectorAll('#ol-roster li').length >= 2, null, { timeout: 30000 });
await host.click('#ol-ready'); await g.click('#ol-ready');
await host.waitForFunction(() => !document.getElementById('ol-go').disabled, null, { timeout: 20000 });
await host.click('#ol-go');
await g.waitForFunction(() => window.__duckWorld.state.phase === 'countdown' || window.__duckWorld.state.phase === 'race', null, { timeout: 60000 });
const slot = await g.evaluate(() => window.__duckWorld.session().mySlot);
await g.reload({ waitUntil: 'load' });
await g.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 120000 });
await g.waitForFunction(() => window.__duckWorld.state.phase === 'race' && window.__duckWorld.session() && window.__duckWorld.session().live, null, { timeout: 60000 });
const autoBefore = await host.evaluate((s) => window.__duckWorld.session().live.ducks[s].autopilot, slot);
await g.keyboard.down('ArrowLeft');
await host.waitForTimeout(2500);
await g.keyboard.up('ArrowLeft');
const after = await host.evaluate((s) => { const d = window.__duckWorld.session().live.ducks[s]; return { autopilot: d.autopilot, lat: +d.lat.toFixed(1) }; }, slot);
const slotAfter = await g.evaluate(() => window.__duckWorld.session().mySlot);
console.log(`slot before/after reload: ${slot}/${slotAfter}; host saw autopilot while gone: ${autoBefore}; after input: ${JSON.stringify(after)}`);
const pass = slot === slotAfter && after.autopilot === false && !issues.length;
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
console.log(pass ? 'PASS' : 'FAIL');
await b.close();
process.exit(pass ? 0 : 1);
