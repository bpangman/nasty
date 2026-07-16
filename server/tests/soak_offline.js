// Offline soak test - #autotest (4P FFA all-CPU) and #autotest6 (6P teams all-CPU).
// Usage: node soak_offline.js [4|6|both]
const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const path = require('path');

async function runOne(hashTag, label, timeoutMs) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const url = 'file:///Users/jarvis/nasty-game/index.html#' + hashTag;
  const t0 = Date.now();
  await page.goto(url);
  // poll for G.over
  let over = false;
  while (Date.now() - t0 < timeoutMs) {
    over = await page.evaluate(() => !!(window.G && window.G.over));
    if (over) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const elapsed = Date.now() - t0;
  let dbl = { bad: false };
  if (over) {
    dbl = await page.evaluate(() => {
      const G = window.G, LAY = window.LAY;
      const seen = new Map();
      for (let s = 0; s < G.n; s++) {
        for (const p of G.pieces[s]) {
          if (p.state !== 'track') continue;
          const abs = window.loopIdx(s, p.steps);
          if (seen.has(abs)) return { bad: true, abs, a: seen.get(abs), b: s };
          seen.set(abs, s);
        }
      }
      return { bad: false };
    });
  }
  await browser.close();
  console.log(`${label}: over=${over} elapsed=${elapsed}ms errors=${errors.length} doubleOcc=${dbl.bad}`);
  if (errors.length) console.log('  errors:', errors.slice(0, 5));
  if (dbl.bad) console.log('  double occupancy:', dbl);
  return { over, elapsed, errors: errors.length, doubleOcc: dbl.bad };
}

async function main() {
  const which = process.argv[2] || 'both';
  const results = {};
  if (which === '4' || which === 'both') results['4p'] = await runOne('autotest', '4P FFA', 6 * 60 * 1000);
  if (which === '6' || which === 'both') results['6p'] = await runOne('autotest6', '6P teams', 12 * 60 * 1000);
  console.log(JSON.stringify(results));
  const fail = Object.values(results).some((r) => !r.over || r.errors > 0 || r.doubleOcc);
  process.exit(fail ? 1 : 0);
}
main();
