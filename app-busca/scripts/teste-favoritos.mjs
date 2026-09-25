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

// A conta de produção já tem favoritos de verdade (do usuário) — comparar
// contra o tamanho ANTES, nunca contra 0/1 fixo, e nunca apagar o que já
// estava lá.
const antesDoTeste = await page.evaluate(() => fetch('/api/favorites', { credentials: 'same-origin' }).then((r) => r.json()));
const totalAntes = antesDoTeste.length;

await page.goto(`${API}/busca`, { waitUntil: 'networkidle' });
await page.waitForSelector('.grade .card', { timeout: 15000 });

const candidato = page.locator('.grade .card').filter({ hasNot: page.locator('button.ico[aria-pressed="true"]') }).first();
// O id, não o título: o worker recoleta ao vivo e pode reclassificar o
// título entre uma leitura e outra — o id é a identidade estável do lote.
// E a partir daqui a busca é sempre por [data-id]: um locator baseado em
// ".filter(hasNot pressed)" se re-resolve a cada chamada, e depois do clique
// o próprio card deixa de bater no filtro — o "estrela" apontaria pra OUTRO
// cartão.
const idLote = await candidato.getAttribute('data-id');
const cardFixo = page.locator(`.grade .card[data-id="${idLote}"]`);
const estrela = cardFixo.locator('button.ico');
await estrela.waitFor({ state: 'visible' });
await page.screenshot({ path: 'shots/favoritos-1-antes.png' });

afirma((await estrela.getAttribute('aria-pressed')) === 'false', 'estrela nasce apagada no card (lote ainda não favoritado)');

await estrela.click();
await page.waitForTimeout(400);
afirma((await estrela.getAttribute('aria-pressed')) === 'true', 'estrela acende ao clicar (otimista, sem esperar rede)');

// Confere no servidor, não só na tela: o clique tem de ter persistido.
const doServidor = await page.evaluate(() => fetch('/api/favorites', { credentials: 'same-origin' }).then((r) => r.json()));
afirma(doServidor.length === totalAntes + 1, `POST persistiu no banco (${totalAntes} → ${doServidor.length})`);
afirma(doServidor.some((f) => String(f.id) === idLote), `o lote favoritado (${idLote}) está na lista`);

await page.click('button[role=tab]:has-text("Favoritos")');
await page.waitForSelector('.grade .card, .empty', { timeout: 10000 });
await page.screenshot({ path: 'shots/favoritos-2-aba.png' });

const idsNaAba = await page.locator('.grade .card').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
afirma(idsNaAba.length === totalAntes + 1, `aba Favoritos mostra ${totalAntes + 1} cards (achou ${idsNaAba.length})`);
afirma(idsNaAba.includes(idLote), `o lote favoritado (${idLote}) aparece na aba`);

const cardRecemFavoritado = page.locator(`.grade .card[data-id="${idLote}"]`);
await cardRecemFavoritado.locator('button.ico').click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/favoritos-3-depois-remover.png' });
afirma(await page.locator(`.grade .card[data-id="${idLote}"]`).count() === 0, 'desfavoritar pela aba remove só aquele card');

const doServidorDepois = await page.evaluate(() => fetch('/api/favorites', { credentials: 'same-origin' }).then((r) => r.json()));
afirma(doServidorDepois.length === totalAntes, `DELETE persistiu no banco (voltou a ${totalAntes})`);

// Lote ENCERRADO favoritado não pode voltar a aparecer na lista — achado em
// produção (786068 do freitas, já vendido, continuava em /api/favorites).
const encerrado = await page.evaluate(async () => {
  const r = await fetch('/api/search?status=encerrado&pageSize=1', { credentials: 'same-origin' });
  return (await r.json()).items[0];
});
if (encerrado) {
  await page.evaluate((id) => fetch('/api/favorites', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lotId: id }),
  }), encerrado.id);
  const listaComEncerrado = await page.evaluate(() => fetch('/api/favorites', { credentials: 'same-origin' }).then((r) => r.json()));
  afirma(!listaComEncerrado.some((f) => f.id === encerrado.id), `lote encerrado (${encerrado.id}) favoritado não aparece na lista`);
  await page.evaluate((id) => fetch(`/api/favorites/${id}`, { method: 'DELETE', credentials: 'same-origin' }), encerrado.id);
} else {
  afirma(false, 'não achei nenhum lote encerrado na base pra testar o filtro');
}

await browser.close();

console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntodas passaram');
process.exit(falhas.length ? 1 : 0);
