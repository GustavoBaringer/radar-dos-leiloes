/**
 * Prova que "Abrir no site do leiloeiro" leva ao anúncio, não à home.
 *
 * O ponto do teste não é o href de um lote: é sobreviver ao ESCRITOR. Este
 * campo já voltou para a home três vezes hoje porque um processo em background
 * segurava o conector antigo. Por isso a fase 3 força uma coleta pela fila e
 * reafirma depois — sem isso o teste mede um instante, não o comportamento.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = 'http://localhost:4500';
const LOTE_REF = 87132;
const SLUG_REF = '/lote/honda-civic-2018-judicial-vlance-87132';
const ESPERADO_REF = 'https://www.cidafixerleiloes.com.br/leilao/index/leilao_id/98341/lote/211432';
const DEEP = /^https:\/\/[^/]+\/leilao\/index\/leilao_id\/\d+\/lote\/\d+$/;
const HOME = /^https?:\/\/[^/]+\/?$/;

const sql = (q) =>
  execSync(`docker exec leilao-db psql -U leilao -d leilao -t -A -F'|' -c ${JSON.stringify(q.replace(/\s+/g, ' '))}`)
    .toString().trim().split('\n').filter(Boolean).map((l) => l.split('|'));

const falhas = [];
const ok = (cond, nome, detalhe = '') => {
  console.log(`  ${cond ? 'PASSA' : 'FALHA'}  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
  if (!cond) falhas.push(nome);
};

const b = await chromium.launch({ headless: true, executablePath: '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const p = await ctx.newPage();

const rede = [];
p.on('response', (r) => {
  if (r.url().includes('/api/lot/')) rede.push({ url: r.url(), status: r.status(), t: Date.now() });
});

await p.goto(`${BASE}/login`);
await p.fill('#usuario', env.APP_USUARIO);
await p.fill('#senha', env.APP_SENHA);
await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);

async function hrefDoBotao(caminho) {
  await p.goto(BASE + caminho, { waitUntil: 'networkidle' });
  await p.evaluate(() => { window.__sentinela = Date.now(); });
  await p.waitForTimeout(1800);
  const naoRecarregou = await p.evaluate(() => typeof window.__sentinela === 'number');
  const href = await p.locator('a.open-src').getAttribute('href').catch(() => null);
  return { href, naoRecarregou };
}

console.log('\n1. Lote de referência, na tela');
const ref = await hrefDoBotao(SLUG_REF);
ok(ref.href === ESPERADO_REF, 'href é o anúncio, não a home', ref.href ?? '(sem botão)');
ok(ref.naoRecarregou, 'a página não recarregou durante a asserção');
ok(rede.some((r) => r.url.endsWith(`/api/lot/${LOTE_REF}`) && r.status === 200),
   'o href veio de /api/lot respondido nesta navegação',
   rede.map((r) => `${r.url.split('/api')[1]}=${r.status}`).join(' '));

console.log('\n2. População no banco (o par que discrimina)');
const [[deep, home, total]] = sql(
  `SELECT count(*) FILTER (WHERE lot_url ~ '/leilao/index/leilao_id/'),
          count(*) FILTER (WHERE lot_url ~ '^https?://[^/]+/?$'),
          count(*) FROM lots WHERE source_id='vlance'`);
ok(Number(home) === 0, 'nenhum lote vlance aponta para a home', `${deep} profundos / ${home} home / ${total} total`);

console.log('\n3. Amostra renderizada, tenants diferentes');
const amostra = sql(
  `SELECT id, lot_url, title_display FROM lots WHERE source_id='vlance' AND id % 811 = 0 LIMIT 4`);
for (const [id, url, titulo] of amostra) {
  const r = await hrefDoBotao(`/lote/x-${id}`);
  ok(r.href === url && DEEP.test(r.href ?? ''), `lote ${id} (${(titulo || '').slice(0, 26)})`, r.href ?? '(sem botão)');
}

console.log('\n4. Regressão: outras fontes não quebraram');
const outras = sql(
  `SELECT source_id, count(*) FILTER (WHERE lot_url IS NULL OR lot_url !~ '^https?://')
     FROM lots WHERE source_id <> 'vlance' GROUP BY 1`);
for (const [fonte, ruins] of outras) ok(Number(ruins) === 0, `${fonte}: toda URL é http(s)`, `${ruins} inválidas`);

console.log('\n5. Sobrevive ao escritor: coleta forçada pela fila');
const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
const r = await fetch(`${BASE}/api/collect`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ sourceId: 'vlance', limit: 120 }),
});
ok(r.ok, 'coleta enfileirada', `http ${r.status}`);
const antes = Date.now();
let regravados = 0;
for (let i = 0; i < 90; i++) {
  await new Promise((s) => setTimeout(s, 3000));
  const [[n]] = sql(`SELECT count(*) FROM lots WHERE source_id='vlance' AND collected_at > now() - interval '3 minutes'`);
  regravados = Number(n);
  if (regravados > 0 && Date.now() - antes > 20000) break;
}
const [[deep2, home2]] = sql(
  `SELECT count(*) FILTER (WHERE lot_url ~ '/leilao/index/leilao_id/'),
          count(*) FILTER (WHERE lot_url ~ '^https?://[^/]+/?$') FROM lots WHERE source_id='vlance'`);
ok(regravados > 0, 'a coleta realmente regravou lotes', `${regravados} lotes tocados`);
ok(Number(home2) === 0, 'depois da coleta, nenhum voltou para a home', `${deep2} profundos / ${home2} home`);
const dep = await hrefDoBotao(SLUG_REF);
ok(dep.href === ESPERADO_REF, 'lote de referência continua apontando para o anúncio', dep.href ?? '(sem botão)');

await b.close();
console.log(`\n${falhas.length ? 'VERMELHO: ' + falhas.join(' | ') : 'VERDE: todas as asserções passaram'}`);
process.exit(falhas.length ? 1 : 0);
