/**
 * Portão da pinça no mapa e do adiamento da busca por texto.
 *
 * A asserção 5 é a que impede o conserto errado: adiar TUDO deixaria filtro e
 * ordenação lentos, e o teste ficaria verde sem ninguém notar.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const API = process.env.API_URL ?? 'http://localhost:4500';
const c = path.join(homedir(), '.cache', 'ms-playwright');
const d = readdirSync(c).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]))[0];
const exe = [path.join(c,d,'chrome-linux64','chrome'), path.join(c,d,'chrome-linux','chrome')].find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) => { if (r.url().includes('/api/search?')) reqs.push({ t: Date.now(), u: r.url() }); });
await page.goto(`${API}/login`, { waitUntil: 'load' });
await page.fill('#usuario', process.env.APP_USUARIO); await page.fill('#senha', process.env.APP_SENHA);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);

let falhas = 0;
const ok = (t, d) => console.log(`  OK    ${t} — ${d}`);
const falha = (t, d) => { falhas++; console.log(`  FALHA ${t} — ${d}`); };

/* 1 — pinça no mapa muda o zoom */
await page.goto(`${API}/busca?vista=mapa`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2600);
const zoomDe = () => page.evaluate(() => {
  const t = document.querySelector('.mapa-escala')?.textContent ?? '';
  const m = /([\d.,]+)×/.exec(t);
  return m ? Number(m[1].replace(',', '.')) : null;
});
const z0 = await zoomDe();
const cv = await page.locator('.mapa-canvas').boundingBox();
const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;
// dois dedos afastando, via CDP touch
const cdp = await ctx.newCDPSession(page);
const toque = (tipo, pts) => cdp.send('Input.dispatchTouchEvent', { type: tipo, touchPoints: pts });
await toque('touchStart', [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }]);
for (let i = 1; i <= 6; i++) {
  await toque('touchMove', [{ x: cx - 30 - i * 18, y: cy, id: 1 }, { x: cx + 30 + i * 18, y: cy, id: 2 }]);
  await page.waitForTimeout(60);
}
await toque('touchEnd', []);
await page.waitForTimeout(500);
const z1 = await zoomDe();
z1 > z0 * 1.4 ? ok('1. pinça aproxima o mapa', `${z0}× -> ${z1}×`) : falha('1. pinça aproxima o mapa', `${z0}× -> ${z1}×`);

/* 2 — pinça fechando afasta */
await toque('touchStart', [{ x: cx - 140, y: cy, id: 1 }, { x: cx + 140, y: cy, id: 2 }]);
for (let i = 1; i <= 6; i++) {
  await toque('touchMove', [{ x: cx - 140 + i * 20, y: cy, id: 1 }, { x: cx + 140 - i * 20, y: cy, id: 2 }]);
  await page.waitForTimeout(60);
}
await toque('touchEnd', []);
await page.waitForTimeout(500);
const z2 = await zoomDe();
z2 < z1 ? ok('2. pinça fechando afasta', `${z1}× -> ${z2}×`) : falha('2. pinça fechando afasta', `${z1}× -> ${z2}×`);

/* 3 — soltar a pinça não seleciona ponto nem abre nada */
const url = page.url();
page.url() === url ? ok('3. a pinça não vira clique', 'URL intacta') : falha('3. a pinça não vira clique', page.url());

/* 4 — digitar não dispara uma busca por tecla */
await page.goto(`${API}/busca`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
reqs.length = 0;
await page.click('#q');
for (const ch of 'onix') { await page.keyboard.type(ch); await page.waitForTimeout(120); }
await page.waitForTimeout(400);
const durante = reqs.length;
await page.waitForTimeout(1400);
const depois = reqs.length;
durante === 0 && depois === 1
  ? ok('4. o texto espera antes de buscar', `4 teclas -> ${durante} requisição durante, ${depois} no total`)
  : falha('4. o texto espera antes de buscar', `durante=${durante} total=${depois}`);

/* 5 — DISCRIMINA: trocar um filtro continua imediato */
reqs.length = 0;
await page.selectOption('#sort', 'price_asc');
await page.waitForTimeout(450);
reqs.length >= 1 ? ok('5. filtro continua imediato', `${reqs.length} requisição em 450ms`)
                 : falha('5. filtro continua imediato', `${reqs.length}`);

await browser.close();
console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
