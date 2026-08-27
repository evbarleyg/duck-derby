// M2/M3 integration test: one host + N guests (separate browser contexts) through the local relay.
// Lobby converges, ready-gating works, host starts, everyone races (guests steer by keyboard), and every client
// ends with the host's canonical finish order. usage: node tools/nettest.mjs [guests=2] [relay=ws://localhost:8787]
// Needs: npm run serve (port 8080) and node tools/relay.mjs running.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [guestsArg = '2', relay = 'ws://localhost:8787', base = 'http://localhost:8080/world.html'] = process.argv.slice(2);
const GUESTS = Number(guestsArg);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const issues = [];
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's', ...a);
async function open(label, url, vp = { width: 400, height: 240 }) {
  const context = await browser.newContext({ viewport: vp });
  const page = await context.newPage();
  page.on('pageerror', (e) => issues.push(`${label} pageerror: ${e.message} @ ${(e.stack || '').split('\n').slice(1, 3).join(' | ')}`));
  page.on('console', (m) => { if (m.type() === 'error') issues.push(`${label} console: ${m.text()}`); });
  await page.addInitScript((name) => { window.name = 'ddw-' + name; localStorage.setItem('duckworld:v1', JSON.stringify({ myName: name, flySeen: true, coached: true, sound: false })); }, label);
  await page.goto(url + `&sound=0&noadapt=1&q=low&relay=${encodeURIComponent(relay)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__duckWorld && document.getElementById('boot') === null, null, { timeout: 90000 });
  return page;
}
// host creates the room
const host = await open('host', `${base}?host=1`);
await host.waitForFunction(() => document.getElementById('ol-code').textContent.trim().length === 4 && /Hosting/.test(document.getElementById('ol-status').textContent), null, { timeout: 30000 });
const code = (await host.textContent('#ol-code')).trim();
log('room', code);
const guests = [];
for (let g = 0; g < GUESTS; g++) guests.push(await open('guest' + (g + 1), `${base}?room=${code}`));
// roster converges everywhere: host + guests racers
const everyone = [host, ...guests];
for (const p of everyone) await p.waitForFunction((n) => document.querySelectorAll('#ol-roster li').length >= n, GUESTS + 1, { timeout: 30000 });
log('roster converged on all clients:', await host.$$eval('#ol-roster li .nm', (els) => els.map((e) => e.textContent.replace(/HOST|YOU|TV/g, '').trim()).join(', ')));
// ready gating: GO disabled until all ready
const goDisabled0 = await host.$eval('#ol-go', (b) => b.disabled);
for (const p of everyone) await p.click('#ol-ready');
await host.waitForFunction(() => !document.getElementById('ol-go').disabled, null, { timeout: 20000 });
log('GO gating: disabled before ready =', goDisabled0, '→ enabled after everyone ready');
await host.click('#ol-go');
// countdown -> race on all
for (const p of everyone) await p.waitForFunction(() => window.__duckWorld.state.phase === 'race', null, { timeout: 60000 });
log('all racing');
// guests steer a bit (keyboard), host idles (AI would not take over the host's own duck; it just drifts)
for (const [i, g] of guests.entries()) { await g.keyboard.down(i % 2 ? 'ArrowLeft' : 'ArrowRight'); setTimeout(() => g.keyboard.up(i % 2 ? 'ArrowLeft' : 'ArrowRight').catch(() => {}), 3000); }
// sample mid-race: guests receive snapshots, host receives inputs
await host.waitForTimeout(6000);
const mid = await Promise.all(everyone.map((p) => p.evaluate(() => { const w = window.__duckWorld; const s = w.session(); return { t: +w.state.t.toFixed(1), snapsIn: s.stats.snapsIn, rtcIn: s.stats.rtcFramesIn || 0, rtcPeers: s.stats.rtcPeers ?? null, via: s.rtcLinked ? 'rtc' : 'relay', inputsIn: s.stats.inputsIn, inputsOut: s.stats.inputsOut, snapsOut: s.stats.snapsOut, rtt: Math.round(s.clock.rtt || 0), mySlot: s.mySlot, myS: s.live && s.mySlot >= 0 ? +s.live.ducks[s.mySlot].s.toFixed(0) : null }; })));
log('mid-race', JSON.stringify(mid));
// wait for results everywhere
for (const p of everyone) await p.waitForFunction(() => window.__duckWorld.state.phase === 'results' && !document.getElementById('results').hidden, null, { timeout: 240000 });
const orders = await Promise.all(everyone.map((p) => p.$$eval('#res-board > li .nm', (els) => els.map((e) => e.childNodes[0].textContent.trim()).join(' > '))));
log('results:');
orders.forEach((o, i) => console.log('   ', i === 0 ? 'host  ' : 'guest' + i, o));
const same = orders.every((o) => o === orders[0]);
console.log(same ? 'PASS: identical draft order on every client' : 'FAIL: orders differ');
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
process.exit(same && !issues.length ? 0 : 1);
