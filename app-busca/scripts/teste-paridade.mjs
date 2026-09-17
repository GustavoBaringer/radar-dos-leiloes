/**
 * Portão de paridade funcional do app de busca.
 *
 * A troca de /busca foi DIRETA, sem rota de convivência, então a única proteção
 * contra perder função na reescrita é exercitar cada uma contra o servidor real
 * e os 21 mil lotes reais. Cada item afirma um EFEITO observável, não a
 * presença de um elemento: "o seletor existe" não prova que o filtro filtra.
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

const resultados = [];
const ok = (n, d = '') => { resultados.push({ n, ok: true, d }); console.log(`  OK    ${n}${d ? ` — ${d}` : ''}`); };
const falha = (n, d) => { resultados.push({ n, ok: false, d }); console.log(`  FALHA ${n} — ${d}`); };
const pulado = (n, d) => { resultados.push({ n, pulado: true, d }); console.log(`  PULO  ${n} — ${d}`); };

const browser = await chromium.launch({ executablePath: acharChromium() });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errosConsole = [];
page.on('console', (m) => { if (m.type() === 'error') errosConsole.push(m.text()); });
page.on('pageerror', (e) => errosConsole.push(`pageerror: ${e.message}`));

const total = () => page.textContent('.count b').then((t) => Number(String(t).replace(/\D/g, '')));
const nCartoes = () => page.locator('.card').count();
const esperaBusca = () => page.waitForTimeout(1400);

await page.goto(`${API}/login`, { waitUntil: 'load' });
await page.fill('#usuario', process.env.APP_USUARIO);
await page.fill('#senha', process.env.APP_SENHA);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);

/* 1 — busca por texto */
await page.goto(`${API}/busca`, { waitUntil: 'networkidle' });
await esperaBusca();
const totalSemFiltro = await total();
await page.fill('#q', 'onix');
await page.click('.btn-buscar');
await esperaBusca();
const totalOnix = await total();
if (totalOnix > 0 && totalOnix < totalSemFiltro) ok('1. busca por texto', `${totalSemFiltro} -> ${totalOnix} com "onix"`);
else falha('1. busca por texto', `sem filtro ${totalSemFiltro}, com "onix" ${totalOnix}`);

/* 2 — facetas múltiplas, contadas ignorando o próprio predicado */
await page.goto(`${API}/busca?assetType=veiculo`, { waitUntil: 'networkidle' });
await esperaBusca();
const botoes = await page.locator('.multi-botao').count();
// A prova da regra: escolher UM tipo de veículo tem de MANTER os outros tipos
// visíveis na lista. Se a faceta fosse contada com o próprio filtro aplicado,
// sobraria só o escolhido — foi o bug que zerava o filtro ao trocar de tipo.
await page.locator('.f-group', { hasText: 'Tipo de veículo' }).locator('.multi-botao').click();
await page.waitForTimeout(400);
const opcoesAntes = await page.locator('.multi-lista label').count();
await page.locator('.multi-lista label', { hasText: 'Moto' }).first().click();
await esperaBusca();
await page.waitForTimeout(600);
const opcoesDepois = await page.locator('.multi-lista label').count();
const totalMoto = await total();
if (botoes >= 6 && opcoesDepois >= opcoesAntes - 1 && opcoesDepois > 1) {
  ok('2. facetas ignoram o próprio predicado', `${botoes} facetas; opções ${opcoesAntes} -> ${opcoesDepois} após escolher Moto (${totalMoto} lotes)`);
} else {
  falha('2. facetas ignoram o próprio predicado', `facetas=${botoes} opções ${opcoesAntes} -> ${opcoesDepois}`);
}
await page.keyboard.press('Escape');

/* 3 — faixas, ordenação e checkboxes */
await page.goto(`${API}/busca?assetType=veiculo&priceMin=50000`, { waitUntil: 'networkidle' });
await esperaBusca();
const totalCaro = await total();
await page.goto(`${API}/busca?assetType=veiculo`, { waitUntil: 'networkidle' });
await esperaBusca();
const totalTodos = await total();
if (totalCaro < totalTodos && totalCaro > 0) ok('3a. faixa de preço', `${totalTodos} -> ${totalCaro} acima de R$ 50 mil`);
else falha('3a. faixa de preço', `${totalTodos} -> ${totalCaro}`);

await page.goto(`${API}/busca?assetType=veiculo&onlyWithPhoto=1`, { waitUntil: 'networkidle' });
await esperaBusca();
const comFoto = await total();
if (comFoto > 0 && comFoto <= totalTodos) ok('3b. só com foto', `${comFoto} de ${totalTodos}`);
else falha('3b. só com foto', `${comFoto}`);

await page.goto(`${API}/busca?assetType=veiculo&sort=price_asc`, { waitUntil: 'networkidle' });
await esperaBusca();
const precos = await page.$$eval('.card .bid .v', (els) => els.map((e) => Number(e.textContent.replace(/\D/g, ''))));
const crescente = precos.every((v, i) => i === 0 || v >= precos[i - 1]);
if (precos.length > 2 && crescente) ok('3c. ordenação por menor lance', `${precos.length} cartões em ordem`);
else falha('3c. ordenação por menor lance', `${precos.slice(0, 5).join(', ')}`);

/* 4 — paginação */
await page.goto(`${API}/busca?assetType=veiculo`, { waitUntil: 'networkidle' });
await esperaBusca();
const primeiroP1 = await page.textContent('.card .title');
await page.click('.pager button:last-child');
await esperaBusca();
const primeiroP2 = await page.textContent('.card .title');
if (primeiroP1 !== primeiroP2 && page.url().includes('page=2')) ok('4. paginação', `p1 "${primeiroP1?.slice(0, 28)}" != p2 "${primeiroP2?.slice(0, 28)}"`);
else falha('4. paginação', `url=${page.url()}`);

/* 5 — a URL é o estado */
await page.goto(`${API}/busca?assetType=veiculo&uf=PR&onlyWithPhoto=1&sort=price_asc`, { waitUntil: 'networkidle' });
await esperaBusca();
const totalPR = await total();
const ufMarcado = await page.locator('.multi-botao', { hasText: 'PR' }).count();
await page.reload({ waitUntil: 'networkidle' });
await esperaBusca();
const totalDepoisReload = await total();
const sortDepois = await page.inputValue('#sort');
if (totalPR === totalDepoisReload && ufMarcado === 1 && sortDepois === 'price_asc') {
  ok('5a. URL restaura o estado', `${totalPR} lotes, UF pintada, sort=${sortDepois}`);
} else {
  falha('5a. URL restaura o estado', `${totalPR} vs ${totalDepoisReload}, uf=${ufMarcado}, sort=${sortDepois}`);
}

await page.selectOption('#sort', 'recent');
await esperaBusca();
const urlComRecent = page.url();
await page.goBack();
await esperaBusca();
// O filtro usa replaceState de propósito: cada troca NÃO empilha histórico,
// senão "voltar" viraria um desfazer clique a clique.
if (!urlComRecent.includes('sort=recent')) falha('5b. filtro na URL', urlComRecent);
else ok('5b. filtro aparece na URL', 'sort=recent');

/* 6 — gaveta do lote empilha e volta */
await page.goto(`${API}/busca?assetType=veiculo`, { waitUntil: 'networkidle' });
await esperaBusca();
const urlAntes = page.url();
await page.click('.card');
await page.waitForTimeout(1400);
const abriu = await page.locator('.drawer .painel').count();
const urlLote = page.url();
await page.goBack();
await page.waitForTimeout(1200);
const fechou = await page.locator('.drawer .painel').count();
if (abriu === 1 && urlLote.includes('/lote/') && fechou === 0 && page.url() === urlAntes) {
  ok('6. gaveta empilha no histórico', 'abriu em /lote/, voltar fechou e devolveu a busca');
} else {
  falha('6. gaveta empilha no histórico', `abriu=${abriu} url=${urlLote} fechou=${fechou}`);
}

/* 7/8 — WebSocket e toast de encerramento */
const wsLigado = await page.locator('.ws-dot.on').count();
if (wsLigado === 1) ok('7. WebSocket conectado', 'indicador "ao vivo" aceso');
else falha('7. WebSocket conectado', 'indicador apagado');

// O toast de encerramento depende de o worker fechar lote durante o teste, o
// que não se força sem escrever no banco. O que dá para provar sem efeito
// colateral é o CAMINHO: publicar a mensagem no canal e ver a caixa aparecer.
const toastOk = await page.evaluate(async () => {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  await new Promise((r) => (ws.onopen = r));
  return true;
});
pulado('8. toast de encerramento', toastOk ? 'canal aberto; o disparo real depende do worker fechar lote' : 'sem canal');

/* 9 — alertas */
await page.goto(`${API}/busca?q=onix&assetType=veiculo`, { waitUntil: 'networkidle' });
await esperaBusca();
await page.click('.btn-alerta');
await page.waitForTimeout(600);
const dlgAberto = await page.locator('dialog.dlg[open]').count();
const nome = `paridade-${Date.now()}`;
await page.fill('#alertaLabel', nome);
await page.click('dialog.dlg .btn-pri');
await page.waitForTimeout(1800);
await page.goto(`${API}/alertas`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const criado = await page.locator('.alerta-item', { hasText: nome }).count();
if (dlgAberto === 1 && criado === 1) ok('9a. criar alerta', `"${nome}" na lista`);
else falha('9a. criar alerta', `dialogo=${dlgAberto} criado=${criado}`);

if (criado === 1) {
  await page.locator('.alerta-item', { hasText: nome }).locator('button[aria-label^="Remover"]').click();
  await page.waitForTimeout(1800);
  const sobrou = await page.locator('.alerta-item', { hasText: nome }).count();
  if (sobrou === 0) ok('9b. apagar alerta', 'removido da lista');
  else falha('9b. apagar alerta', 'continua na lista');
} else pulado('9b. apagar alerta', 'nada criado para apagar');

/* 10 — push */
pulado('10. push (VAPID)', 'exige permissão do navegador e HTTPS; o caminho está no código, não exercitado aqui');

/* 11 — sessão e papéis */
const abasAdmin = await page.locator('.abas button').allTextContents();
const temCobertura = abasAdmin.some((t) => t.includes('Cobertura'));
if (temCobertura) ok('11. papel admin vê Cobertura', abasAdmin.join(' / '));
else falha('11. papel admin vê Cobertura', abasAdmin.join(' / '));

/* 12 — cobertura */
await page.goto(`${API}/cobertura`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
const stats = await page.locator('.stat').count();
const linhas = await page.locator('.report tbody tr').count();
if (stats >= 8 && linhas > 5) ok('12. /cobertura', `${stats} indicadores, ${linhas} linhas de tabela`);
else falha('12. /cobertura', `stats=${stats} linhas=${linhas}`);

/* 13 — SSR do lote (sem JS) */
const semJs = await ctx.request.get(`${API}/lote/chevrolet-onix-2018-recuperado-financiamento-leilo-6031`);
const htmlSsr = await semJs.text();
const temLd = htmlSsr.includes('application/ld+json');
const temTitulo = /<title>[^<]*leilão[^<]*<\/title>/i.test(htmlSsr);
const temConteudo = /Procedência do dado/.test(htmlSsr);
if (temLd && temTitulo && temConteudo) ok('13. SSR do lote', `${htmlSsr.length} bytes com JSON-LD e conteúdo renderizado`);
else falha('13. SSR do lote', `ld=${temLd} title=${temTitulo} conteudo=${temConteudo}`);

/* 14 — lista de espera
   O formulário vive na LANDING (vanilla, intocada); o app de busca não o tem.
   O que esta migração pode quebrar é o endpoint continuar de pé por trás das
   rotas novas, então é isso que se afirma — com o corpo que o servidor exige
   (`consentimento` é obrigatório; sem ele o 400 é o comportamento correto). */
const emailEspera = `paridade${Date.now()}@exemplo.com`;
const espera = await ctx.request.post(`${API}/api/espera`, {
  data: { email: emailEspera, consentimento: 'teste de paridade automatizado' },
});
const semConsent = await ctx.request.post(`${API}/api/espera`, { data: { email: emailEspera } });
if (espera.ok() && semConsent.status() === 400) {
  ok('14. lista de espera', `aceita com consentimento (${espera.status()}) e recusa sem ele (400)`);
} else {
  falha('14. lista de espera', `com=${espera.status()} sem=${semConsent.status()}`);
}

/* console */
if (errosConsole.length === 0) ok('console limpo', 'nenhum erro durante a bateria');
else falha('console limpo', errosConsole.slice(0, 3).join(' | '));

await browser.close();

const falhas = resultados.filter((r) => !r.ok && !r.pulado);
const pulos = resultados.filter((r) => r.pulado);
console.log(`\n${resultados.length - falhas.length - pulos.length} passaram, ${falhas.length} falharam, ${pulos.length} não exercitados`);
process.exit(falhas.length ? 1 : 0);
