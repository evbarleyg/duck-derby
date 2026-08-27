// Regression for the two prod bugs reported 2026-08-27 (PHASE4-NOTES "BUG — live 2-tab repro"):
//  1. a cold first load of ?room=CODE must land on the join lobby (panel visible, connected, no race camera),
//  2. a host who has used the seeded game before ("Start together" on, stored roster) and does NOTHING after
//     clicking "Host a race" must still be in the lobby 70 s later (no auto-start, URL still ?room=CODE).
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
const issues = [];
const R = encodeURIComponent(relay);
const stored = { names: ['Quack Sparrow', 'Duck Norris', 'Mallory', 'Sir Waddles', 'Bill Murray', 'Puddles', 'Feather Locklear', 'Drake'], lobby: true, fly: true, flySeen: false, coached: false, sound: false };
async function open(label, url, vp, storedObj) {
  const ctx = await b.newContext({ viewport: vp });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => issues.push(`${label} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') issues.push(`${label} console: ${m.text()}`); if (/\[net\]/.test(m.text())) console.log(`   ${label} ${m.text()}`); });
  if (storedObj) await p.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('duckworld:v1', JSON.stringify(s)); sessionStorage.setItem('seeded', '1'); } }, storedObj);
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 90000 });
  return p;
}
let ok = true;
const host = await open('host', `${base}?relay=${R}&sound=0&noadapt=1`, { width: 900, height: 500 }, stored);
await host.click('#btn-host');
await host.waitForFunction(() => /Hosting/.test(document.getElementById('ol-status').textContent), null, { timeout: 30000 });
const code = (await host.textContent('#ol-code')).trim();
console.log('host room', code);
// cold guest: brand-new context, first load of the link
const guest = await open('guest', `${base}?room=${code}&relay=${R}&sound=0&noadapt=1`, { width: 390, height: 844 }, null);
await guest.waitForTimeout(4000);
const g = await guest.evaluate(() => ({ phase: window.__duckWorld.state.phase, online: !!window.__duckWorld.state.online, lobbyVisible: !document.getElementById('online').hidden, status: document.getElementById('ol-status').textContent, rows: document.querySelectorAll('#ol-roster li').length, cam: window.__duckWorld.rig.mode }));
console.log('cold guest:', JSON.stringify(g));
if (!(g.online && g.lobbyVisible && /Connected/.test(g.status) && g.rows >= 2 && g.cam === 'menu')) { ok = false; console.log('FAIL: cold-loaded guest is not sitting in a connected lobby'); }
// host idles for 70 s
const startedAt = Date.now();
while (Date.now() - startedAt < 70000) {
  await host.waitForTimeout(10000);
  const h = await host.evaluate(() => ({ phase: window.__duckWorld.state.phase, lobbyPhase: window.__duckWorld.session().lobby.phase, lobbyVisible: !document.getElementById('online').hidden, url: location.search }));
  console.log(`host after ${Math.round((Date.now() - startedAt) / 1000)} s:`, JSON.stringify(h));
  if (h.phase !== 'menu' || h.lobbyPhase !== 'lobby' || !h.lobbyVisible || !/room=/.test(h.url)) { ok = false; console.log('FAIL: idle host left the lobby'); break; }
}
await b.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
console.log(ok && !issues.length ? 'PASS' : 'FAIL');
process.exit(ok && !issues.length ? 0 : 1);
