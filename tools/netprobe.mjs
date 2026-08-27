// M1 transport probe: two headless browser contexts join one room and measure broadcast RTT + delivery.
//   node tools/netprobe.mjs relay      -> against tools/relay.mjs on ws://localhost:8787 (start it first)
//   node tools/netprobe.mjs supabase   -> against the provisioned Supabase project (needs network access to *.supabase.co)
// Prints the RTT distribution (ms) and loss; exits non-zero on failure. Serve the repo root on :8080 first (npm run serve).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(import.meta.url)(root + '/playwright');
  }
}
const [kind = 'relay', base = 'http://localhost:8080/net-probe.html', n = '40'] = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const room = 'PROBE' + Math.floor(Math.random() * 1e4);
const issues = [];
async function ctx(role, extra = '') {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => issues.push(role + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') issues.push(role + ' console: ' + m.text()); });
  await page.goto(`${base}?kind=${kind}&room=${room}&role=${role}&auto=1&n=${n}${extra}${kind === 'relay' ? '&relay=ws://localhost:8787' : ''}`);
  return page;
}
const echo = await ctx('echo');
await echo.waitForTimeout(1500);
const ping = await ctx('ping');
const t0 = Date.now();
try {
  await ping.waitForFunction(() => window.__probe && (window.__probe.done || window.__probe.error), null, { timeout: 60000 });
} catch { /* fall through */ }
const res = await ping.evaluate(() => window.__probe);
const echoRes = await echo.evaluate(() => window.__probe);
console.log(`transport=${kind} room=${room} took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (res.error) console.log('ERROR:', res.error);
console.log('ping summary:', JSON.stringify(res.summary || null));
console.log('echo received:', echoRes.received);
await browser.close();
console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'no console errors');
process.exit(res.summary && res.summary.n > 0 ? 0 : 1);
