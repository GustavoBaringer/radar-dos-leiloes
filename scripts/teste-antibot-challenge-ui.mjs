import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg' };
const loginSource = await readFile(path.join(root, 'src/web/login-template.ts'), 'utf8');
const loginMatch = loginSource.match(/export const PAGINA_LOGIN = `([\s\S]*)`;\s*$/);
assert(loginMatch, 'PAGINA_LOGIN template export found');
const loginHtml = loginMatch[1].replace('__DE__', '/busca').replace('__ABERTO__', '1').replace('__ERRO__', '');
let mode = 'off', postStatus = 200, sdkUnavailable = false;
const posts = [], sdkRequests = [];
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/api/security-config') {
    res.setHeader('cache-control', 'no-store'); res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ enabled: mode === 'enforce', siteKey: mode === 'enforce' ? 'test-site-key' : null, actions: ['login', 'cadastro', 'espera'] }));
  }
  if (u.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && ['/api/login', '/api/cadastro', '/api/espera'].includes(u.pathname)) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const data = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      posts.push({ path: u.pathname, data });
      if (postStatus === 302) { res.writeHead(302, { location: '/done' }); return res.end(); }
      const status = postStatus; postStatus = 200;
      res.writeHead(status, { 'content-type': 'application/json', 'retry-after': status === 429 ? '11' : '3' });
      return res.end(JSON.stringify(status === 200 ? { mensagem: 'Cadastro recebido!' } : status === 429 ? { error: 'rate_limited', retryAfterSeconds: 11 } : { error: 'challenge_unavailable', retryAfterSeconds: 3 }));
    }
    if (u.pathname === '/api/vitrine') return json(res, { total: 1, totalLeiloeiros: 1, ufs: [], categorias: [], recentes: [], heroes: [] });
    if (u.pathname === '/api/me') return json(res, { logado: false });
    return json(res, {});
  }
  if (u.pathname === '/done') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Done</title>'); }
  const file = u.pathname === '/' ? 'landing-antibot.html' : u.pathname === '/login' ? null : decodeURIComponent(u.pathname.slice(1));
  if (u.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(loginHtml); }
  const target = path.resolve(root, 'src/web', file ?? '');
  if (!target.startsWith(path.resolve(root, 'src/web') + path.sep)) { res.writeHead(404); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[path.extname(target)] ?? 'application/octet-stream' }); res.end(await readFile(target)); }
  catch { res.writeHead(404); res.end(); }
});
function json(res, body) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

let browser;
const results = [];
const record = async (name, fn) => { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); };
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath() }); }
  catch (e) { throw new Error(`BROWSER_UNAVAILABLE: ${e.message}`); }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      if (url.hostname === 'challenges.cloudflare.com') {
        sdkRequests.push(url.href);
        if (sdkUnavailable) return route.abort();
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: `window.__ts={actions:[],resets:0,removed:0};window.turnstile={render:function(el,o){var id='widget';window.__ts.actions.push(o.action);window.__ts.opts=o;return id},execute:function(){var b=window.__challengeBehavior||'token';if(b==='token')window.__ts.opts.callback('fixture-token');else if(b==='expired')window.__ts.opts['expired-callback']();else if(b==='error')window.__ts.opts['error-callback']()},reset:function(){window.__ts.resets++},remove:function(){window.__ts.removed++}};` });
      }
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  const gotoLanding = async (nextMode) => { mode = nextMode; postStatus = 200; await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('#cadNome').waitFor(); };
  const fillCadastro = async () => {
    await page.locator('#cadNome').fill('Ada Lovelace'); await page.locator('#cadDocumento').fill('52998224725');
    await page.locator('#cadEmail').fill('ada@example.test'); await page.locator('#cadCelular').fill('11987654321');
    await page.locator('#cadAceite').check();
  };
  await record('off: no SDK request, one business POST, existing consent fields retained', async () => {
    posts.length = 0; sdkRequests.length = 0; await gotoLanding('off'); await fillCadastro();
    await page.locator('#btnCadastro').click(); await page.getByText('Cadastro recebido!', { exact: false }).waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].data.turnstileToken, undefined);
    assert.match(posts[0].data.consentimento, /Termos de Uso/); assert.equal(posts[0].data.consentimentoVersao, '2026-10-02'); assert.equal(posts[0].data.marketing, false);
    assert.equal(sdkRequests.length, 0);
  });
  await record('enforce cadastro: exact action/token/business fields, one POST and token reset', async () => {
    posts.length = 0; await gotoLanding('enforce'); await fillCadastro(); await page.locator('#btnCadastro').click();
    await page.getByText('Cadastro recebido!', { exact: false }).waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].path, '/api/cadastro'); assert.equal(posts[0].data.turnstileToken, 'fixture-token');
    assert.equal(posts[0].data.nome, 'Ada Lovelace'); assert.match(posts[0].data.consentimento, /CPF\/CNPJ/);
    assert.deepEqual(await page.evaluate(() => window.__ts.actions), ['cadastro']); assert.equal(await page.evaluate(() => window.__ts.resets), 1);
  });
  for (const behavior of ['expired', 'error']) await record(`enforce ${behavior}: blocks POST and exposes accessible Portuguese status`, async () => {
    posts.length = 0; await gotoLanding('enforce'); await page.evaluate((v) => { window.__challengeBehavior = v; }, behavior); await fillCadastro();
    await page.locator('#btnCadastro').click(); await page.locator('#avisoCadastro[role="status"]').waitFor();
    assert.equal(posts.length, 0); assert.match(await page.locator('#avisoCadastro').innerText(), /verificação/i);
  });
  await record('SDK loading failure: retry recovers and continues once', async () => {
    posts.length = 0; sdkUnavailable = true; await gotoLanding('enforce'); await page.locator('.challenge-retry').waitFor();
    sdkUnavailable = false; await page.locator('.challenge-retry').click(); await page.waitForFunction(() => window.__ts?.actions.includes('cadastro'));
    await fillCadastro(); await page.locator('#btnCadastro').click(); await page.getByText('Cadastro recebido!', { exact: false }).waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].data.turnstileToken, 'fixture-token');
  });
  for (const status of [429, 503]) await record(`${status}: retry delay announced without resubmission`, async () => {
    posts.length = 0; await gotoLanding('off'); postStatus = status; await fillCadastro(); await page.locator('#btnCadastro').click();
    await page.getByText(status === 429 ? /11 segundos/ : /3 segundos/).waitFor();
    assert.equal(posts.length, 1);
  });
  await record('login uses action login and same POST carries credentials plus token', async () => {
    mode = 'enforce'; postStatus = 302; posts.length = 0; await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ts?.actions.includes('login'));
    const loginActions = await page.evaluate(() => window.__ts.actions);
    await page.locator('#usuario').fill('ada'); await page.locator('#senha').fill('secret'); await page.locator('form.formlogin button[type="submit"]').click();
    await page.waitForURL(`${base}/done`); assert.equal(posts.length, 1); assert.equal(posts[0].path, '/api/login');
    assert.equal(posts[0].data.turnstileToken, 'fixture-token'); assert.equal(posts[0].data.usuario, 'ada'); assert.equal(posts[0].data.senha, 'secret');
    assert.deepEqual(loginActions, ['login']);
  });
  await context.close();
} catch (e) {
  console.error(`FAIL ${e.message}`); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
if (!process.exitCode) console.log(JSON.stringify({ results, sdkRequests, posts: posts.length, fixtureHost: '127.0.0.1', cleanup: 'browser/context/server closed' }, null, 2));
