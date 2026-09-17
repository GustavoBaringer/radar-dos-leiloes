/**
 * A lateral de filtros é alcançável sem rolar a PÁGINA inteira?
 *
 * A primeira versão deste teste media o overflow do elemento errado (`.filtros`
 * em vez do contêiner sticky) e afirmava "visível sem rolar", que deixou de ser
 * a pergunta certa: com rolagem interna o botão não precisa estar visível de
 * cara, precisa ser alcançável rolando a LATERAL.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const API = process.env.API_URL ?? 'http://localhost:4500';
function ach(){const c=path.join(homedir(),'.cache','ms-playwright');const r=d=>Number(d.split('-').pop());
for(const d of readdirSync(c).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>r(b)-r(a)))
for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const e=path.join(c,d,rel);if(existsSync(e))return e}return null}
const b = await chromium.launch({ executablePath: ach() });
let falhas = 0;
for (const [w, h] of [[1440, 900], [1920, 1080], [1280, 720]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  await p.goto(`${API}/login`, { waitUntil: 'load' });
  await p.fill('#usuario', process.env.APP_USUARIO);
  await p.fill('#senha', process.env.APP_SENHA);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  await p.goto(`${API}/busca?assetType=imovel&uf=PR`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1800);

  const r = await p.evaluate(() => {
    const wrap = document.querySelector('.lateral-desktop');
    const cs = getComputedStyle(wrap);
    const limpar = document.querySelector('.btn-clear');
    const scrollYAntes = window.scrollY;
    // Rola só a LATERAL até o fim.
    wrap.scrollTop = wrap.scrollHeight;
    const rect = limpar.getBoundingClientRect();
    return {
      overflowY: cs.overflowY,
      maxHeight: cs.maxHeight,
      alturaContainer: Math.round(wrap.clientHeight),
      conteudo: Math.round(wrap.scrollHeight),
      rolouSozinha: wrap.scrollTop > 0,
      paginaFicouParada: window.scrollY === scrollYAntes,
      limparNaTela: rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  // A armadilha do contêiner de rolagem: a lista da faceta é `position:absolute`
  // e seria cortada pela borda. A última faceta (Comitente) é o pior caso.
  await p.evaluate(() => { document.querySelector('.lateral-desktop').scrollTop = 0; });
  await p.locator('.f-group', { hasText: 'Comitente' }).locator('.multi-botao').click();
  await p.waitForTimeout(700);
  const lista = await p.evaluate(() => {
    const l = document.querySelector('.multi-lista');
    if (!l) return null;
    const wrap = document.querySelector('.lateral-desktop').getBoundingClientRect();
    const b = l.getBoundingClientRect();
    return {
      alturaVisivel: Math.round(Math.min(b.bottom, wrap.bottom) - Math.max(b.top, wrap.top)),
      altura: Math.round(b.height),
      opcoes: l.querySelectorAll('label').length,
    };
  });
  const listaOk = lista != null && lista.alturaVisivel >= Math.min(lista.altura, 180);
  const ok = r.overflowY === 'auto' && r.paginaFicouParada && r.limparNaTela && listaOk;
  if (!ok) falhas++;
  console.log(
    `${ok ? 'OK   ' : 'FALHA'} ${w}x${h}: container ${r.alturaContainer}px / conteúdo ${r.conteudo}px | overflow=${r.overflowY} ` +
    `| página parada: ${r.paginaFicouParada} | "Limpar filtros" alcançável: ${r.limparNaTela}` +
    ` | lista da última faceta: ${lista ? `${lista.alturaVisivel}/${lista.altura}px visíveis, ${lista.opcoes} opções` : 'NÃO ABRIU'}`,
  );
  await ctx.close();
}
await b.close();
process.exit(falhas ? 1 : 0);
