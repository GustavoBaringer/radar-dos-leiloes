/**
 * A página pública do lote: o que o link compartilhado abre.
 *
 * Afirma as duas metades do contrato — o visitante ANÔNIMO vê o lote, e a API
 * continua fechada para ele. Uma sem a outra não serve: abrir a página sem
 * fechar a API seria expor o índice; fechar tudo é o bug que o preview do
 * WhatsApp denunciou.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const API = process.env.API_URL ?? 'http://localhost:4500';
const SLUG = 'mercedes-benz-gla-2019-sinistrado-copart-5291';
function ach(){const c=path.join(homedir(),'.cache','ms-playwright');const r=d=>Number(d.split('-').pop());
for(const d of readdirSync(c).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>r(b)-r(a)))
for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const e=path.join(c,d,rel);if(existsSync(e))return e}return null}

let falhas = 0;
const ok = (n, d='') => console.log(`  OK    ${n}${d?` — ${d}`:''}`);
const falha = (n, d) => { falhas++; console.log(`  FALHA ${n} — ${d}`); };

const b = await chromium.launch({ executablePath: ach() });

/* anônimo */
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const erros = [];
  p.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  const r = await p.goto(`${API}/lote/${SLUG}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);

  r.status() === 200 ? ok('anônimo recebe 200', 'sem redirect para /login')
                     : falha('anônimo recebe 200', `HTTP ${r.status()} em ${p.url()}`);

  const titulo = await p.textContent('#drawerTitle').catch(() => null);
  titulo ? ok('o lote aparece', titulo.slice(0, 40)) : falha('o lote aparece', 'sem título');

  const temBusca = await p.locator('.grade, .filtros').count();
  temBusca === 0 ? ok('a busca NÃO aparece para anônimo') : falha('a busca não deve aparecer', `${temBusca} elementos`);

  const convite = await p.locator('.convite').count();
  convite === 1 ? ok('convite para entrar presente') : falha('convite para entrar', 'ausente');

  const link = await p.locator('a.open-src').getAttribute('href').catch(() => null);
  link?.startsWith('http') ? ok('link para o leiloeiro', link.slice(0, 44)) : falha('link para o leiloeiro', String(link));

  const hidr = erros.filter((e) => /hydrat|React error #4(18|21|23|25)/i.test(e));
  hidr.length === 0 ? ok('hidratação limpa em modo público') : falha('hidratação', hidr[0].slice(0, 90));
  erros.length === 0 ? ok('console limpo') : falha('console limpo', erros.slice(0, 2).join(' | '));

  for (const e of ['/api/search', '/api/lot/5291', '/api/stats', '/api/alerts', '/api/me']) {
    const res = await ctx.request.get(`${API}${e}`);
    if (res.status() !== 401) { falha(`${e} fechado para anônimo`, `HTTP ${res.status()}`); }
  }
  ok('a API segue fechada', '5 endpoints em 401');
  await p.screenshot({ path: 'shots/publico-1280.png', fullPage: true });
  await ctx.close();
}

/* a volta: quem entra pelo link compartilhado tem de VOLTAR para o anúncio */
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${API}/lote/${SLUG}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  await p.click('.topo-entrar');
  await p.waitForLoadState('load');
  const noLogin = p.url().includes('/login');
  const destino = await p.locator('input[name="de"]').getAttribute('value').catch(() => null);
  noLogin && destino === `/lote/${SLUG}`
    ? ok('o login recebe o destino', destino)
    : falha('o login recebe o destino', `url=${p.url()} de=${destino}`);

  await p.fill('#usuario', process.env.APP_USUARIO);
  await p.fill('#senha', process.env.APP_SENHA);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  await p.waitForTimeout(1800);

  const voltou = p.url().endsWith(`/lote/${SLUG}`);
  voltou ? ok('depois de entrar, volta para o anúncio', p.url().replace(API, ''))
         : falha('depois de entrar, volta para o anúncio', `terminou em ${p.url()}`);

  // E volta AUTENTICADO, não na versão pública.
  const gaveta = await p.locator('.drawer .painel').count();
  const titulo = await p.textContent('#drawerTitle').catch(() => null);
  gaveta === 1 && titulo
    ? ok('volta como usuário logado', `gaveta aberta em "${titulo.slice(0, 32)}"`)
    : falha('volta como usuário logado', `gaveta=${gaveta} titulo=${titulo}`);
  await ctx.close();
}

/* com sessão: a gaveta sobre a busca continua funcionando */
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${API}/login`, { waitUntil: 'load' });
  await p.fill('#usuario', process.env.APP_USUARIO);
  await p.fill('#senha', process.env.APP_SENHA);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  await p.goto(`${API}/lote/${SLUG}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  const gaveta = await p.locator('.drawer .painel').count();
  const pagina = await p.locator('.lote-pagina').count();
  gaveta === 1 && pagina === 0
    ? ok('com sessão continua sendo a gaveta sobre a busca')
    : falha('com sessão', `gaveta=${gaveta} pagina=${pagina}`);
  await ctx.close();
}

await b.close();
console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
