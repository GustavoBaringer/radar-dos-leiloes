/** Captura só a dobra (viewport), onde o PNG de página inteira fica ilegível. */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL ?? 'http://localhost:13000';
const API = 'http://localhost:4500';
const alvos = JSON.parse(process.argv[2]);
mkdirSync('shots', { recursive: true });

function acharChromium() {
  const cache = path.join(homedir(), '.cache', 'ms-playwright');
  const rev = (d) => Number(d.split('-').pop());
  for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => rev(b) - rev(a))) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const exe = path.join(cache, dir, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const browser = await chromium.launch({ executablePath: acharChromium() });
for (const a of alvos) {
  const ctx = await browser.newContext({ viewport: { width: a.w, height: a.h }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`${API}/login`, { waitUntil: 'load' });
  await page.fill('#usuario', process.env.APP_USUARIO);
  await page.fill('#senha', process.env.APP_SENHA);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  await page.goto(`${APP}${a.rota}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (a.clique) await page.click(a.clique, { timeout: 8000 }).catch(() => console.warn(`  sem ${a.clique}`));
  await page.waitForTimeout(a.espera ?? 1200);
  // Quantas colunas a grade realmente tem — a medição vale mais que o olho no PNG.
  const cols = await page.evaluate(() => {
    const g = document.querySelector('.grade');
    if (!g) return null;
    return { cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  console.log(`${a.nome}: colunas=${cols?.cols} overflowX=${cols?.overflow}`);
  await page.screenshot({ path: `shots/${a.nome}.png` });
  console.log(`ok shots/${a.nome}.png`);
  await ctx.close();
}
await browser.close();
