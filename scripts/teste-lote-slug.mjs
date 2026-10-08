/**
 * Smoke opt-in com os dois lotes do relato, sem criar fixtures nem alterar o banco.
 * Requer .env local e contas de portão existentes. Não é uma suíte hermética.
 * BASE=http://localhost:4500 MODE=all node --env-file=.env --import tsx scripts/teste-lote-slug.mjs
 * MODE aceita back/front/all; CHROMIUM_PATH sobrescreve o navegador do Playwright.
 */
import { chromium } from 'playwright-core';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import { criarToken } from '../src/core/auth.ts';

const { Pool } = pg;
const BASE = (process.env.BASE ?? 'http://localhost:4500').replace(/\/$/, '');
const MODE = process.env.MODE ?? 'all';
const IDS = [548219, 548216];
const paths = {
  renault: '/lote/renault-duster-2023-sinistrado-copart-548219',
  fiat: '/lote/fiat-fiorino-2020-sinistrado-copart-548216',
  mismatch: '/lote/fiat-fiorino-2020-sinistrado-copart-548219',
  random: '/lote/aleatorio-548219',
  malformed: ['/lote/548219', '/lote/lote-0548219', '/lote/unsafe', '/lote/0', '/lote/lote-0', '/lote/lote-9007199254740992'],
};
const token = criarToken('comum');
const cookieHeader = `radar_sessao=${token}`;
const failures = [];
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://leilao:leilao@127.0.0.1:5433/leilao' });

function assert(ok, message) {
  if (!ok) throw new Error(message);
}
async function test(name, fn, page = null) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
    if (process.env.QA_DIR && page) {
      await mkdir(process.env.QA_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.QA_DIR}/${name.replace(/[^a-z0-9-]/gi, '_')}.png`, fullPage: true }).catch(() => {});
    }
  }
}
async function snapshot() {
  const result = await pool.query('SELECT id, to_jsonb(lots) AS row FROM lots WHERE id = ANY($1::bigint[]) ORDER BY id', [IDS]);
  return JSON.stringify(result.rows);
}
function assertRedirect(res, destination) {
  assert(res.status === 302, `esperava 302; recebeu ${res.status}`);
  assert(new URL(res.headers.get('location'), BASE).pathname + new URL(res.headers.get('location'), BASE).search === destination,
    `redirect inesperado: ${res.headers.get('location')}`);
}
async function get(path, headers = {}) {
  return fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
}
async function head(path, headers = {}) {
  return fetch(`${BASE}${path}`, { method: 'HEAD', headers, redirect: 'manual' });
}
async function checkSsr(path, id) {
  const res = await get(path, { cookie: cookieHeader });
  assert(res.status === 200, `status ${res.status}`);
  assert(/private/i.test(res.headers.get('cache-control') ?? '') && /no-store/i.test(res.headers.get('cache-control') ?? ''), 'detalhe não tem Cache-Control private, no-store');
  const html = await res.text();
  assert(html.includes(`"id":${id}`) || html.includes(`"id":"${id}"`), `__LOTE__ não contém id ${id}`);
  const canonicalTag = html.match(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  assert(canonicalTag && new URL(canonicalTag[1], BASE).pathname === path, 'canonical não aponta para o caminho requisitado');
  return html;
}

async function backend() {
  const before = await snapshot();
  try {
    await test('SSR Renault slug/id/canonical', async () => { await checkSsr(paths.renault, 548219); });
    await test('SSR Fiat slug/id/canonical', async () => { await checkSsr(paths.fiat, 548216); });
    await test('slug Frankenstein retorna 404 sem vazar Renault', async () => {
      const res = await get(paths.mismatch, { cookie: cookieHeader });
      const html = await res.text();
      assert(res.status === 404, `status ${res.status}`);
      assert(/no-store/i.test(res.headers.get('cache-control') ?? ''), 'Cache-Control não contém no-store');
      assert(!/Renault Duster/i.test(html) && !html.includes('__LOTE__'), 'conteúdo do Renault/ __LOTE__ vazado');
    });
    await test('prefixo adulterado percent-encoded retorna 404 sem vazar lote', async () => {
      const res = await get('/lote/%66iat-fiorino-2020-sinistrado-copart-548219', { cookie: cookieHeader });
      const html = await res.text();
      assert(res.status === 404, `status ${res.status}`);
      assert(!/Renault Duster|Fiat Fiorino/i.test(html) && !html.includes('__LOTE__'), 'conteúdo de lote/ __LOTE__ vazado');
    });
    await test('slug canônico percent-encoded pode resolver apenas o id correspondente', async () => {
      const res = await get('/lote/%72enault-duster-2023-sinistrado-copart-548219', { cookie: cookieHeader });
      const html = await res.text();
      assert(res.status === 200 || res.status === 404, `status inesperado ${res.status}`);
      if (res.status === 200) assert(html.includes('"id":548219') || html.includes('"id":"548219"'), 'slug encoded resolveu id incorreto');
      else assert(!/Renault Duster/i.test(html) && !html.includes('__LOTE__'), '404 expôs conteúdo');
    });
    await test('HEAD anônimo bloqueado e HEAD autenticado mismatch retorna 404', async () => {
      for (const path of [paths.renault, paths.mismatch]) {
        const anon = await head(path);
        assert(anon.status === 302 && new URL(anon.headers.get('location'), BASE).pathname === '/login', `HEAD anônimo ${path} status/redirect ${anon.status}`);
        assert((await anon.text()) === '', `HEAD anônimo ${path} retornou corpo`);
      }
      const mismatch = await head(paths.mismatch, { cookie: cookieHeader });
      assert(mismatch.status === 404, `HEAD mismatch status ${mismatch.status}`);
      assert(/no-store/i.test(mismatch.headers.get('cache-control') ?? ''), 'HEAD mismatch não contém no-store');
      assert((await mismatch.text()) === '', 'HEAD mismatch retornou corpo');
    });
    await test('slug aleatório retorna 404', async () => {
      const res = await get(paths.random, { cookie: cookieHeader });
      assert(res.status === 404, `status ${res.status}`);
    });
    for (const path of paths.malformed) await test(`path inválido ${path} redireciona para busca`, async () => {
      assertRedirect(await get(path, { cookie: cookieHeader }), '/busca');
    });
    await test('lote inexistente redireciona para busca', async () => {
      assertRedirect(await get('/lote/lote-9007199254740991', { cookie: cookieHeader }), '/busca');
    });
    for (const path of [paths.renault, paths.mismatch]) await test(`anônimo ${path} redireciona ao login sem dados`, async () => {
      const res = await get(path);
      const html = await res.text();
      const target = new URL(res.headers.get('location'), BASE);
      assert(res.status === 302 && target.pathname === '/login', `status/redirect ${res.status} ${target.pathname}`);
      assert(target.searchParams.get('de') === path, 'parâmetro de retorno de login incorreto');
      assert(!/Renault Duster/i.test(html) && !html.includes('__LOTE__'), 'dados do lote expostos');
    });
    await test('cookie inválido redireciona para login', async () => {
      const res = await get(paths.renault, { cookie: 'radar_sessao=invalido' });
      assert(res.status === 302 && new URL(res.headers.get('location'), BASE).pathname === '/login', 'não redirecionou para login');
    });
    for (const endpoint of ['/api/lot/548219', '/api/lots']) await test(`API anônima ${endpoint} exige autenticação mesmo com XFF`, async () => {
      const res = await get(endpoint, { 'x-forwarded-for': '127.0.0.1' });
      assert(res.status === 401, `status ${res.status}`);
    });
    await test('API autenticada retorna lote correto', async () => {
      const res = await get('/api/lot/548219', { cookie: cookieHeader });
      assert(res.status === 200, `status ${res.status}`);
      const body = await res.json();
      assert(String(body?.id ?? body?.lot?.id) === '548219', 'id da API inesperado');
    });
    await test('homepage/vitrine sem parâmetros não amplia catálogo', async () => {
      const home = await get('/');
      assert(home.status === 200, `homepage status ${home.status}`);
      const vitrine = await get('/api/vitrine');
      assert(vitrine.status === 200, `vitrine status ${vitrine.status}`);
      const body = await vitrine.json();
      assert(Array.isArray(body.recentes) && body.recentes.length <= 8, 'recentes não está limitado a 8');
      assert(Array.isArray(body.leiloeiros) && body.leiloeiros.length <= 12, 'leiloeiros não está limitado a 12');
      for (const path of ['/api/vitrine?id=548219', '/api/vitrine?page=999999']) {
        const res = await get(path);
        assert(res.status < 500, `${path} status ${res.status}`);
        const data = await res.json();
        assert(Array.isArray(data.recentes) && data.recentes.length <= 8, `${path} não respeitou teto de recentes`);
        assert(Array.isArray(data.leiloeiros) && data.leiloeiros.length <= 12, `${path} não respeitou teto de leiloeiros`);
      }
    });
  } finally {
    const after = await snapshot();
    await test('GETs não alteraram linhas lote 548219/548216', async () => assert(before === after, 'snapshot antes/depois divergiu'));
  }
}

async function frontend() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath() });
  const network = [];
  const pageErrors = [];
  try {
    for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
      const anon = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await anon.newPage();
      page.on('request', (req) => network.push({ at: new Date().toISOString(), url: req.url() }));
      page.on('response', (res) => network.push({ at: new Date().toISOString(), status: res.status(), url: res.url() }));
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await test(`${viewport.name}: card real da homepage leva ao login`, async () => {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        const probe = await page.evaluate(() => ({
          h1: [...document.querySelectorAll('h1')].some((el) => el.getClientRects().length > 0),
          login: [...document.querySelectorAll('button, a')].some((el) => el.getClientRects().length > 0 && /entrar|login/i.test(el.textContent ?? '')),
        }));
        assert(probe.h1 || probe.login || await page.locator('a[href^="/lote/"]').count(), 'DOM inicial sem elementos sondáveis');
        const card = page.locator('#lotesGrade a.card[href^="/lote/"]').first();
        await card.waitFor({ state: 'visible', timeout: 10000 });
        await card.click();
        await page.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
        assert(await page.locator('#abrir').isVisible(), 'controle de login #abrir não visível');
      }, page);
      await test(`${viewport.name}: acesso direto anônimo ao Frankenstein pede login`, async () => {
        await page.goto(`${BASE}${paths.mismatch}`, { waitUntil: 'domcontentloaded' });
        await page.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
        assert(new URL(page.url()).searchParams.get('de') === paths.mismatch, 'destino de login não preservou slug');
        assert(await page.locator('#abrir').isVisible(), '#abrir não visível após redirect ao login');
        assert(!(await page.locator('body').innerText()).includes('Renault Duster'), 'Renault exposto');
      }, page);
      await anon.close();

      const auth = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await auth.addCookies([{ name: 'radar_sessao', value: token, url: BASE }]);
      const authenticated = await auth.newPage();
      authenticated.on('request', (req) => network.push({ at: new Date().toISOString(), url: req.url() }));
      authenticated.on('response', (res) => network.push({ at: new Date().toISOString(), status: res.status(), url: res.url() }));
      authenticated.on('pageerror', (err) => pageErrors.push(err.message));
      await test(`${viewport.name}: SSR legítimo e navegação Frankenstein`, async () => {
        const res = await authenticated.goto(`${BASE}${paths.renault}`, { waitUntil: 'domcontentloaded' });
        assert(res?.status() === 200, `SSR status ${res?.status()}`);
        const detail = authenticated.getByRole('dialog');
        await detail.waitFor({ state: 'visible', timeout: 10000 });
        assert(/Renault|Duster/i.test(await detail.innerText()), 'texto do lote não visível no dialog');
        const bad = await authenticated.goto(`${BASE}${paths.mismatch}`, { waitUntil: 'domcontentloaded' });
        assert(bad?.status() === 404, `Frankenstein status ${bad?.status()}`);
        await authenticated.waitForFunction(() => document.body.innerText.includes('Lote não encontrado.'), undefined, { timeout: 10000 });
        assert(!/Renault Duster/i.test(await authenticated.locator('body').innerText()), 'título Renault visível');
        assert(await authenticated.evaluate(() => !window.__LOTE__), 'window.__LOTE__ presente');
      }, authenticated);
      await test(`${viewport.name}: popstate não reutiliza lote e limpa inválido`, async () => {
        await authenticated.goto(`${BASE}${paths.renault}`, { waitUntil: 'networkidle' });
        await authenticated.getByRole('dialog').waitFor({ state: 'visible' });
        await authenticated.evaluate((path) => {
          window.__sentinela = Date.now();
          history.pushState({}, '', path);
          dispatchEvent(new PopStateEvent('popstate'));
        }, paths.mismatch);
        await authenticated.waitForFunction(() => document.body.innerText.includes('Lote não encontrado.'), undefined, { timeout: 10000 });
        assert(await authenticated.evaluate(() => window.__sentinela > 0), 'navegação recarregou a página');
        await authenticated.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 });
        await authenticated.evaluate((path) => {
          history.pushState({}, '', path);
          dispatchEvent(new PopStateEvent('popstate'));
        }, '/lote/unsafe');
        await authenticated.waitForFunction(() => document.body.innerText.includes('Lote não encontrado.'), undefined, { timeout: 10000 });
        await authenticated.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 });
      }, authenticated);
      await auth.close();
    }
    await test('sem erros JavaScript de página', async () => assert(pageErrors.length === 0, pageErrors.join(' | ')));
  } finally {
    if (process.env.QA_DIR) {
      await mkdir(process.env.QA_DIR, { recursive: true });
      await import('node:fs/promises').then(({ writeFile }) => writeFile(`${process.env.QA_DIR}/rede.json`, JSON.stringify(network, null, 2)));
    }
    await browser.close();
  }
}

try {
  assert(['back', 'front', 'all'].includes(MODE), `MODE inválido: ${MODE}`);
  if (MODE === 'back' || MODE === 'all') await backend();
  if (MODE === 'front' || MODE === 'all') await frontend();
} catch (error) {
  failures.push('execução');
  console.log(`FAIL execução: ${error?.message ?? error}`);
} finally {
  await pool.end();
}
console.log(JSON.stringify({ mode: MODE, failures }, null, 2));
if (failures.length) process.exitCode = 1;
