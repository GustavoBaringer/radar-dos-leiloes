/**
 * Prova o EFEITO ponta a ponta: clicar na estrela do card muda a aba
 * Favoritos, e desfavoritar de dentro dela some com o card — não só "o botão
 * existe".
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const API = 'http://localhost:4500';

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

const falhas = [];
function afirma(cond, msg) {
  console.log(`  ${cond ? 'OK' : 'FALHOU'}   ${msg}`);
  if (!cond) falhas.push(msg);
}

const browser = await chromium.launch({ executablePath: acharChromium() });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

await page.goto(`${API}/login`, { waitUntil: 'load' });
await page.fill('#usuario', process.env.APP_USUARIO);
await page.fill('#senha', process.env.APP_SENHA);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);

await page.goto(`${API}/busca`, { waitUntil: 'networkidle' });
await page.waitForSelector('.grade .card', { timeout: 15000 });

const primeiroCard = page.locator('.grade .card').first();
// O id, não o título: o worker recoleta ao vivo e pode reclassificar o
// título entre uma leitura e outra — o id é a identidade estável do lote.
const idLote = await primeiroCard.getAttribute('data-id');
const estrela = primeiroCard.locator('button.ico');
await estrela.waitFor({ state: 'visible' });
await page.screenshot({ path: 'shots/favoritos-1-antes.png' });

afirma((await estrela.getAttribute('aria-pressed')) === 'false', 'estrela nasce apagada no card');

await estrela.click();
await page.waitForTimeout(400);
afirma((await estrela.getAttribute('aria-pressed')) === 'true', 'estrela acende ao clicar (otimista, sem esperar rede)');

// Confere no servidor, não só na tela: o clique tem de ter persistido.
const doServidor = await page.evaluate(() => fetch('/api/favorites', { credentials: 'same-origin' }).then((r) => r.json()));
afirma(doServidor.length === 1, `POST persistiu no banco (${doServidor.length} favorito(s))`);

await page.click('button[role=tab]:has-text("Favoritos")');
await page.waitForSelector('.grade .card, .empty', { timeout: 10000 });
await page.screenshot({ path: 'shots/favoritos-2-aba.png' });

const cardsNaAba = await page.locator('.grade .card').count();
afirma(cardsNaAba === 1, `aba Favoritos mostra exatamente 1 card (achou ${cardsNaAba})`);
const idNaAba = await page.locator('.grade .card').first().getAttribute('data-id');
afirma(idNaAba === idLote, `é o MESMO lote favoritado (busca=${idLote} aba=${idNaAba})`);

await page.locator('.grade .card button.ico').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/favoritos-3-depois-remover.png' });
afirma(await page.locator('.empty').count() > 0, 'desfavoritar pela aba remove o card e mostra o estado vazio');

const doServidorDepois = await page.evaluate(() => fetch('/api/favorites', { credentials: 'same-origin' }).then((r) => r.json()));
afirma(doServidorDepois.length === 0, 'DELETE persistiu no banco (0 favoritos)');

await browser.close();

console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntodas passaram');
process.exit(falhas.length ? 1 : 0);
