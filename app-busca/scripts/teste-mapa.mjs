/**
 * Portão do mapa na busca.
 *
 * Afirma EFEITO, não presença: o que importa é a conta fechar com o total do
 * filtro e o clique num ponto mudar a lista — "o canvas existe" não prova nada.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const API = process.env.API_URL ?? 'http://localhost:4500';
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
let falhas = 0;
const ok = (n, d = '') => console.log(`  OK    ${n}${d ? ` — ${d}` : ''}`);
const falha = (n, d) => { falhas++; console.log(`  FALHA ${n} — ${d}`); };

const browser = await chromium.launch({ executablePath: acharChromium() });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const erros = [];
page.on('pageerror', (e) => erros.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

await page.goto(`${API}/login`, { waitUntil: 'load' });
await page.fill('#usuario', process.env.APP_USUARIO);
await page.fill('#senha', process.env.APP_SENHA);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);

const total = () => page.textContent('.count b').then((t) => Number(String(t).replace(/\D/g, '')));

/* 1 — o botão troca a visualização e a URL carrega o estado */
await page.goto(`${API}/busca`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const temMapaAntes = await page.locator('.mapa-canvas').count();
await page.click('.seg-vista button[aria-pressed="false"]');
await page.waitForTimeout(2500);
const temMapaDepois = await page.locator('.mapa-canvas').count();
temMapaAntes === 0 && temMapaDepois === 1
  ? ok('1. o botão Mapa troca a visualização', 'grade -> mapa')
  : falha('1. o botão Mapa troca a visualização', `antes=${temMapaAntes} depois=${temMapaDepois}`);
new URL(page.url()).searchParams.get('vista') === 'mapa'
  ? ok('2. a visualização cabe na URL', page.url().split('?')[1] ?? '')
  : falha('2. a visualização cabe na URL', page.url());

/* 3 — a conta fecha: pontos + sem localização = total do filtro */
const soma = await page.evaluate(async () => {
  const r = await fetch('/api/search/mapa', { credentials: 'same-origin' }).then((x) => x.json());
  return { emPontos: r.pontos.reduce((t, p) => t + p.n, 0), fora: r.semLocalizacao, total: r.total };
});
soma.emPontos + soma.fora === soma.total
  ? ok('3. a soma dos pontos fecha com o total', `${soma.emPontos} + ${soma.fora} = ${soma.total}`)
  : falha('3. a soma dos pontos fecha com o total', JSON.stringify(soma));

/* 4 — filtro da tela reflete no mapa (e não só na lista) */
const semFiltro = await page.evaluate(() => fetch('/api/search/mapa', { credentials: 'same-origin' }).then((r) => r.json()).then((r) => r.total));
const comFiltro = await page.evaluate(() => fetch('/api/search/mapa?q=apartamento', { credentials: 'same-origin' }).then((r) => r.json()).then((r) => r.total));
comFiltro > 0 && comFiltro < semFiltro
  ? ok('4. a busca por texto reflete no mapa', `${semFiltro} -> ${comFiltro} com "apartamento"`)
  : falha('4. a busca por texto reflete no mapa', `${semFiltro} -> ${comFiltro}`);

/* 5 — o clique num ponto filtra a LISTA pelo número que o ponto anuncia */
const ponto = await page.evaluate(() =>
  fetch('/api/search/mapa', { credentials: 'same-origin' }).then((r) => r.json()).then((r) => r.pontos[0]));
await page.goto(`${API}/busca?vista=mapa&local=${encodeURIComponent(ponto.k)}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const totalDoPonto = await total();
totalDoPonto === ponto.n
  ? ok('5. o ponto filtra a lista', `${ponto.cidade}/${ponto.uf}: o ponto diz ${ponto.n}, a lista mostra ${totalDoPonto}`)
  : falha('5. o ponto filtra a lista', `ponto=${ponto.n} lista=${totalDoPonto}`);

/* 6 — o ponto escolhido NÃO apaga os outros do mapa */
const aindaTemPontos = await page.evaluate(() => {
  const el = document.querySelector('.mapa-escala');
  return Number(String(el?.textContent ?? '').replace(/[^\d.]/g, '').split('.')[0] || 0);
});
aindaTemPontos > 1
  ? ok('6. escolher um ponto não esvazia o mapa', `${aindaTemPontos}+ ainda desenhados`)
  : falha('6. escolher um ponto não esvazia o mapa', String(aindaTemPontos));

/* 7 — ponto empilhado: cidade cuja âncora cai EM CIMA do pátio.
      28% das coordenadas têm mais de um ponto, e sem tratar isso o clique
      dava zoom para sempre e os lotes "só cidade" nunca apareciam. */
const empilhado = await page.evaluate(async () => {
  const r = await fetch('/api/search/mapa', { credentials: 'same-origin' }).then((x) => x.json());
  const por = new Map();
  for (const p of r.pontos) {
    const c = `${p.lat},${p.lon}`;
    if (!por.has(c)) por.set(c, []);
    por.get(c).push(p);
  }
  const g = [...por.values()].filter((v) => v.length > 1)
    .sort((a, b) => b.reduce((t, x) => t + x.n, 0) - a.reduce((t, x) => t + x.n, 0))[0];
  return g ? { chave: g.map((p) => p.k).join(';'), soma: g.reduce((t, p) => t + p.n, 0), cidade: g[0].cidade } : null;
});
if (!empilhado) {
  ok('7. ponto empilhado seleciona o conjunto', 'nenhuma coordenada com dois pontos hoje');
} else {
  await page.goto(`${API}/busca?vista=mapa&local=${encodeURIComponent(empilhado.chave)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const t = await total();
  t === empilhado.soma
    ? ok('7. ponto empilhado seleciona o conjunto', `${empilhado.cidade}: pátio + cidade = ${t}`)
    : falha('7. ponto empilhado seleciona o conjunto', `esperado ${empilhado.soma}, lista ${t}`);
}

/* 8 — console limpo */
erros.length === 0 ? ok('8. console limpo') : falha('8. console limpo', erros.slice(0, 3).join(' | '));

await page.screenshot({ path: 'app-busca/shots/mapa-desktop.png', fullPage: false });
await browser.close();
console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
