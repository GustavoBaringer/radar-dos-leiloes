/**
 * A landing existe para ser lida por gente e por robô de busca, e os dois lados
 * falham calados: o robô sem title/description/JSON-LD, o leitor com seção que
 * estoura a tela. Um terceiro modo de falha é próprio desta página: número
 * chumbado no HTML. O mockup de origem trazia "21.943 lotes" escrito à mão, e
 * uma landing de agregador com número fixo mente no dia seguinte.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4500';
const DIR = '/tmp/claude-1000/-home-gustavopereira-projetos/63e603a2-8717-4a2b-a04d-f0200fa824d5/scratchpad';
const b = await chromium.launch({ headless: true, executablePath: '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const falhas = [];
const ok2 = (c, m) => (c ? console.log(`  PASSA  ${m}`) : falhas.push(m));

// Nenhum dos números do índice pode estar escrito no arquivo servido.
const html = readFileSync('src/web/landing.html', 'utf8');
const api = await (await fetch(`${BASE}/api/vitrine`)).json();
for (const [campo, valor] of Object.entries({ total: api.total, leiloeiros: api.totalLeiloeiros })) {
  if (valor > 999 && html.includes(String(valor))) falhas.push(`número de "${campo}" (${valor}) chumbado no HTML`);
}

for (const [rot, vp] of [['desktop', { width: 1440, height: 950 }], ['mobile', { width: 390, height: 844 }]]) {
  const p = await (await b.newContext({ viewport: vp })).newPage();
  const erros = [];
  p.on('pageerror', (e) => erros.push(e.message));
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#lotesGrade .card', { timeout: 20000 });
  await p.waitForTimeout(2000); // deixa a rede de segurança de 1,5s agir

  const r = await p.evaluate(() => {
    const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .flatMap((s) => { try { const j = JSON.parse(s.textContent); return j['@graph'] ?? [j]; } catch { return ['INVÁLIDO']; } })
      .map((n) => (typeof n === 'string' ? n : n['@type']));
    const txt = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
    return {
      title: document.title,
      description: document.querySelector('meta[name=description]')?.content ?? null,
      canonical: document.querySelector('link[rel=canonical]')?.href ?? null,
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
      h2: document.querySelectorAll('h2').length,
      jsonld: ld,
      // a fonte de display tem de ter carregado, senão a página cai em system-ui
      fonteH1: getComputedStyle(document.querySelector('h1')).fontFamily,
      lotes: txt('#heroLotes'), fontes: txt('#heroFontes'), selo: txt('#seloLeiloeiros'),
      cats: document.querySelectorAll('.cat').length,
      chips: document.querySelectorAll('.chip').length,
      numeros: [...document.querySelectorAll('#numeros dt')].map((d) => d.textContent.trim()),
      barras: document.querySelectorAll('#barras i').length,
      feed: document.querySelectorAll('#feed li').length,
      painel: txt('#painelNome'),
      cards: document.querySelectorAll('#lotesGrade .card').length,
      credito: document.querySelectorAll('#lotesGrade .cred-foto').length,
      leiloeiros: document.querySelectorAll('.leiloeiro').length,
      ufs: document.querySelectorAll('.uf').length,
      faq: document.querySelectorAll('.faq details').length,
      // nada pode ficar preso em opacity 0 esperando observer
      // Sem recorte de viewport: o print de página inteira mostrou uma seção em
      // branco porque ela estava fora da tela e o observador nunca disparou.
      invisiveis: [...document.querySelectorAll('.sobe')].filter((e) => getComputedStyle(e).opacity === '0').length,
      resolve: document.querySelectorAll('#resolve .cartao').length,
      // A barra tem altura fixa de 64px: se a marca ou o CTA quebrarem linha,
      // o conteúdo estoura para fora dela.
      alturaTopo: Math.round(document.querySelector('.topo-inner').getBoundingClientRect().height),
      rolagemH: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // O gutter tem de existir em TODA seção: `padding: a b c` numa regra que
      // também usa .faixa zera o padding-inline e cola o bloco na borda.
      semGutter: [...document.querySelectorAll('.faixa')]
        .filter((e) => parseFloat(getComputedStyle(e).paddingLeft) < 16)
        .map((e) => String(e.className).slice(0, 28)),
      estouram: [...document.querySelectorAll('main *, footer *')]
        .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
        // Elemento cortado por um ancestral com overflow:hidden não vaza na tela:
        // o halo do painel é decoração posicionada fora da caixa de propósito.
        .filter((e) => {
          for (let a = e.parentElement; a; a = a.parentElement) {
            if (getComputedStyle(a).overflow !== 'visible') return false;
          }
          return true;
        })
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 24)}`).slice(0, 5),
    };
  });
  console.log(`\n--- ${rot} ---\n${JSON.stringify(r, null, 2)}`);
  await p.screenshot({ path: `${DIR}/lp-${rot}.png`, fullPage: true });

  if (erros.length) falhas.push(`${rot}: erro de JS — ${erros[0]}`);
  if (r.h1.length !== 1) falhas.push(`${rot}: ${r.h1.length} h1 (deve ser 1)`);
  if (!r.description || r.description.length < 80) falhas.push(`${rot}: meta description curta ou ausente`);
  if (!r.canonical) falhas.push(`${rot}: sem canonical`);
  for (const t of ['WebSite', 'Organization', 'SoftwareApplication', 'FAQPage']) {
    if (!r.jsonld.includes(t)) falhas.push(`${rot}: JSON-LD sem ${t}`);
  }
  if (!/Space Grotesk/.test(r.fonteH1)) falhas.push(`${rot}: fonte de display não carregou (${r.fonteH1})`);
  for (const [k, v] of Object.entries({ lotes: r.lotes, fontes: r.fontes, selo: r.selo })) {
    if (!v || v === '—') falhas.push(`${rot}: número "${k}" não preencheu`);
  }
  if (r.cats !== 5) falhas.push(`${rot}: ${r.cats} categorias (esperado 5)`);
  if (r.chips !== 6) falhas.push(`${rot}: ${r.chips} chips (esperado 6)`);
  if (r.numeros.some((n) => !n || n === '0')) falhas.push(`${rot}: faixa de números parada em ${JSON.stringify(r.numeros)}`);
  if (r.barras !== 12) falhas.push(`${rot}: ${r.barras} barras (esperado 12)`);
  if (!r.feed) falhas.push(`${rot}: painel ao vivo sem lotes`);
  if (!r.cards) falhas.push(`${rot}: grade de lotes vazia`);
  const comLeiloeiro = (api.recentes ?? []).filter((l) => l.auctioneer_name).length;
  if (comLeiloeiro && r.credito < comLeiloeiro) {
    falhas.push(`${rot}: ${comLeiloeiro} lotes têm leiloeiro na API e só ${r.credito} mostram crédito`);
  }
  if (!r.leiloeiros) falhas.push(`${rot}: nenhum leiloeiro`);
  if (!r.ufs) falhas.push(`${rot}: cobertura vazia`);
  if (r.faq !== 7) falhas.push(`${rot}: ${r.faq} perguntas (esperado 7)`);
  if (r.invisiveis) falhas.push(`${rot}: ${r.invisiveis} blocos presos em opacity 0`);
  if (r.resolve !== 6) falhas.push(`${rot}: ${r.resolve} cartões em "o que o Radar faz" (esperado 6)`);
  if (r.alturaTopo > 66) falhas.push(`${rot}: cabeçalho quebrou linha (${r.alturaTopo}px, esperado 64)`);
  if (r.rolagemH > 1) falhas.push(`${rot}: página rola na horizontal (${r.rolagemH}px)`);
  if (r.semGutter?.length) falhas.push(`${rot}: sem gutter lateral em ${r.semGutter.join(', ')}`);
  if (r.estouram.length) falhas.push(`${rot}: elementos fora da tela: ${r.estouram.join(', ')}`);
  await p.close();
}

// A lista de espera tem de gravar de verdade — formulário que não grava é o
// modo de falha que eu me recusei a entregar.
const email = `teste+${Date.now()}@radar-teste.local`;
const env = async () =>
  (await fetch(`${BASE}/api/espera`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, nome: 'Teste', interesse: 'ambos', consentimento: 'texto de consentimento do teste' }),
  })).json();
const um = await env();
const dois = await env();
const ruim = await fetch(`${BASE}/api/espera`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'nao-e-email', consentimento: 'x' }),
});
console.log('\n--- lista de espera ---');
console.log({ primeira: um, repetida: dois, emailInvalido: ruim.status });
if (!um.ok || um.jaEstava) falhas.push('lista de espera: primeiro envio não gravou');
if (!dois.jaEstava) falhas.push('lista de espera: duplicata não foi detectada');
if (ruim.status !== 400) falhas.push(`lista de espera: e-mail inválido devolveu ${ruim.status}, esperado 400`);


// A landing tem de abrir para VISITANTE, sem cookie nenhum — era esse o pedido.
// E o resto do catálogo tem de continuar fechado: uma landing pública que abre
// o índice junto é o defeito oposto, e igualmente silencioso.
{
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const r = await p.goto(`${BASE}/`);
  ok2(r.status() === 200 && !p.url().includes('/login'), `landing abre sem conta (HTTP ${r.status()}, ${p.url()})`);
  await p.waitForSelector('#lotesGrade .card', { timeout: 20000 });
  ok2((await p.locator('#lotesGrade .card').count()) > 0, 'a vitrine desenha lotes para o visitante');
  ok2((await p.locator('#lotesGrade .card img[src^="/api/img"]').count()) > 0, 'as fotos da vitrine carregam pelo proxy');
  // A página do LOTE saiu desta lista de propósito em 17/09: ela é pública para
  // o link compartilhado gerar preview (o robô do WhatsApp lia a tela de login).
  // A busca e os alertas continuam exigindo conta — é o par que interessa:
  // a página abriu, o índice não.
  for (const rota of ['/busca', '/alertas', '/cobertura']) {
    await p.goto(`${BASE}${rota}`);
    ok2(p.url().includes('/login'), `${rota} exige conta (terminou em ${p.url()})`);
  }
  {
    const resp = await p.goto(`${BASE}/lote/mercedes-benz-gla-2019-sinistrado-copart-5291`);
    ok2(
      resp.status() === 200 && !p.url().includes('/login'),
      `a página do lote abre sem conta, para o link compartilhado (HTTP ${resp.status()})`,
    );
    // A asserção certa NÃO é "não contém localhost": acessando por localhost, a
    // origem da requisição é localhost, e refletir isso é o comportamento
    // correto. O que se afirma é que a origem do og:image ACOMPANHA por onde o
    // visitante entrou — era isso que estava quebrado, com a meta apontando
    // para localhost enquanto o link circulava pelo domínio do túnel.
    const og = await p.locator('meta[property="og:image"]').getAttribute('content');
    ok2(Boolean(og) && og.startsWith(`${BASE}/api/img`), `og:image acompanha a origem da requisição (${String(og).slice(0, 46)}…)`);
    // E só um de cada: as metas do template não podem conviver com as do lote.
    ok2(
      (await p.locator('meta[property="og:title"]').count()) === 1,
      'uma única og:title no head (as do template são removidas)',
    );
    ok2((await p.locator('.grade, .filtros').count()) === 0, 'o visitante anônimo não recebe a busca junto');
  }
  const api = await p.evaluate(() => fetch('/api/search?q=hilux').then((r) => r.status));
  ok2(api === 401, `/api/search sem conta devolve 401 (devolveu ${api})`);
  const vitrine = await p.evaluate(() => fetch('/api/vitrine').then((r) => r.json()));
  ok2(vitrine.recentes.length <= 8, `a vitrine devolve no máximo 8 lotes (devolveu ${vitrine.recentes.length})`);
  await ctx.close();
}

await b.close();
console.log(falhas.length ? `\nFALHOU:\n- ${falhas.join('\n- ')}` : '\nOK: landing válida para leitor, para robô e para o formulário.');
process.exit(falhas.length ? 1 : 0);
