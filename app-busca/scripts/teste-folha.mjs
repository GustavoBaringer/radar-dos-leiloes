/**
 * Portão da folha (lista sobre o mapa) no celular.
 *
 * Afirma GESTO e ALTURA medidos, não presença: a folha existia e mesmo assim
 * parava em 62% da tela e só respondia à alça. As asserções 4, 6 e 7 passam dos
 * dois lados de propósito — são as que impedem o conserto de quebrar a rolagem
 * da lista e o toque que abre o anúncio.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const API = process.env.API_URL ?? 'http://localhost:4500';
const cache = path.join(homedir(), '.cache', 'ms-playwright');
const d = readdirSync(cache).filter(x => /^chromium-\d+$/.test(x)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]))[0];
const exe = [path.join(cache,d,'chrome-linux64','chrome'), path.join(cache,d,'chrome-linux','chrome')].find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto(`${API}/login`, { waitUntil: 'load' });
await page.fill('#usuario', process.env.APP_USUARIO);
await page.fill('#senha', process.env.APP_SENHA);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
await page.goto(`${API}/busca?vista=mapa`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2800);

const h = () => page.evaluate(() => Math.round(document.querySelector('.folha-mapa').getBoundingClientRect().height));
const nivel = () => page.evaluate(() => document.querySelector('.folha-puxador').getAttribute('aria-valuenow'));
const scrollTop = () => page.evaluate(() => Math.round(document.querySelector('.folha-rolo').scrollTop));
const janela = await page.evaluate(() => innerHeight);

async function arrasta(seletor, dy, offsetY = 40) {
  const b = await page.locator(seletor).boundingBox();
  const x = b.x + b.width / 2, y = b.y + offsetY;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x, y + (dy * i) / 8); await page.waitForTimeout(35); }
  await page.mouse.up();
  await page.waitForTimeout(550);
}

let falhas = 0;
const ok = (t, d) => console.log(`  OK    ${t} — ${d}`);
const falha = (t, d) => { falhas++; console.log(`  FALHA ${t} — ${d}`); };

/* 1 — no nível espiada, arrastar UM CARD levanta a folha */
const a1 = await h();
await arrasta('.folha-rolo', -320, 40);
const b1 = await h();
b1 > a1 + 100 ? ok('1. arrastar a lista levanta a folha', `${a1}px -> ${b1}px`)
              : falha('1. arrastar a lista levanta a folha', `${a1}px -> ${b1}px`);

/* 2 — arrastar pelo CABEÇALHO também */
const a2 = await h();
await arrasta('.folha-cabecalho', -260, 12);
const b2 = await h();
b2 > a2 ? ok('2. arrastar o cabeçalho levanta a folha', `${a2}px -> ${b2}px`)
        : falha('2. arrastar o cabeçalho levanta a folha', `${a2}px -> ${b2}px`);

/* 3 — no máximo, a altura cobre quase a tela inteira */
await page.focus('.folha-puxador');
for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(350); }
const cheia = await h();
cheia / janela >= 0.85 ? ok('3. a folha cheia cobre a tela', `${cheia}px de ${janela}px (${(100*cheia/janela).toFixed(0)}%)`)
                       : falha('3. a folha cheia cobre a tela', `${cheia}px de ${janela}px (${(100*cheia/janela).toFixed(0)}%)`);

/* 4 — DISCRIMINA: cheia e no topo, puxar para CIMA rola a lista, não estica a folha */
await page.evaluate(() => document.querySelector('.folha-rolo').scrollTo(0, 0));
const a4 = await h();
await page.mouse.move(195, 400);
await page.mouse.wheel(0, 300);
await page.waitForTimeout(400);
const rolou = await scrollTop();
const b4 = await h();
rolou > 0 && b4 === a4 ? ok('4. cheia, a lista rola sem mexer na folha', `scrollTop=${rolou}, folha ${b4}px`)
                       : falha('4. cheia, a lista rola sem mexer na folha', `scrollTop=${rolou}, folha ${a4}->${b4}`);

/* 5 — cheia e no topo da lista, puxar para BAIXO abaixa a folha */
await page.evaluate(() => document.querySelector('.folha-rolo').scrollTo(0, 0));
await page.waitForTimeout(250);
const a5 = await h();
await arrasta('.folha-rolo', 300, 40);
const b5 = await h();
b5 < a5 - 100 ? ok('5. cheia e no topo, puxar para baixo abaixa a folha', `${a5}px -> ${b5}px (nível ${await nivel()})`)
              : falha('5. cheia e no topo, puxar para baixo abaixa a folha', `${a5}px -> ${b5}px`);

/* 6 — arrastar um card NÃO pode abrir o anúncio (o arrasto virou clique?) */
await page.evaluate(() => document.querySelector('.folha-rolo').scrollTo(0, 0));
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(400);
const urlAntes = page.url();
await arrasta('.folha-rolo', -280, 50);
await page.waitForTimeout(600);
const abriu = await page.evaluate(() => !!document.querySelector('.drawer, [role="dialog"]'));
!abriu && page.url() === urlAntes
  ? ok('6. arrastar um card não abre o anúncio', 'nenhuma gaveta aberta')
  : falha('6. arrastar um card não abre o anúncio', `gaveta=${abriu} url mudou=${page.url() !== urlAntes}`);

/* 7 — mas o TOQUE curto no card continua abrindo */
const card = await page.locator('.folha-rolo .card, .folha-rolo article').first().boundingBox();
if (card) {
  await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);
  await page.waitForTimeout(900);
  const abriu2 = await page.evaluate(() => !!document.querySelector('.drawer, [role="dialog"]'));
  abriu2 ? ok('7. o toque curto ainda abre o anúncio', 'gaveta aberta')
         : falha('7. o toque curto ainda abre o anúncio', 'nada abriu');
} else falha('7. o toque curto ainda abre o anúncio', 'nenhum card encontrado');

/* 8 — com a folha CHEIA, a alça e as saídas ficam clicáveis (não cobertas) */
await page.goto(`${API}/busca?vista=mapa`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2600);
await page.focus('.folha-puxador');
for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(320); }
const cobertura = await page.evaluate(() => {
  const alvo = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return { achou: false };
    const b = e.getBoundingClientRect();
    const em = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
    return { achou: true, proprio: !!em && (e === em || e.contains(em)) , quem: em ? em.tagName + '.' + String(em.className).slice(0, 26) : null };
  };
  return { puxador: alvo('.folha-puxador'), verMapa: alvo('.folha-saidas button'), saidas: document.querySelectorAll('.folha-saidas button').length };
});
cobertura.puxador.proprio && cobertura.verMapa.proprio && cobertura.saidas === 2
  ? ok('8. cheia, a alça e as saídas ficam alcançáveis', `${cobertura.saidas} saídas, alça livre`)
  : falha('8. cheia, a alça e as saídas ficam alcançáveis', JSON.stringify(cobertura));

/* 9 — "ver o mapa" devolve o mapa; "grade" troca de visualização */
await page.click('.folha-saidas button >> nth=0');
await page.waitForTimeout(600);
const baixou = await h();
baixou < 300 ? ok('9. "ver o mapa" baixa a folha', `${baixou}px`) : falha('9. "ver o mapa" baixa a folha', `${baixou}px`);
await page.focus('.folha-puxador');
for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(280); }
await page.click('.folha-saidas button >> nth=1');
await page.waitForTimeout(900);
const virouGrade = await page.evaluate(() => !document.querySelector('.mapa-canvas') && !!document.querySelector('.grade'));
virouGrade ? ok('9b. "grade" troca a visualização', 'canvas fora, grade dentro')
           : falha('9b. "grade" troca a visualização', page.url());

await page.screenshot({ path: 'app-busca/shots/folha-gesto.png' });
await browser.close();
console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
