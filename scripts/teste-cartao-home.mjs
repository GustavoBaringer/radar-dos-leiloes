/**
 * O cartão da home tem de se comportar como o da busca. Não basta a home
 * responder 200: o defeito era justamente markup diferente com HTTP igual.
 * Aqui o teste compara os dois lados no navegador de verdade.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:4500';
const b = await chromium.launch({
  headless: true,
  executablePath: '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
});
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

await p.goto(`${BASE}/login`);
await p.fill('#usuario', process.env.APP_USUARIO);
await p.fill('#senha', process.env.APP_SENHA);
await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);

const leCartoes = async (seletor) =>
  p.$$eval(seletor, (nos) =>
    nos.map((n) => ({
      fonte: n.querySelector('.src')?.textContent?.trim() ?? null,
      credito: n.querySelector('.cred-foto')?.textContent?.trim() ?? null,
      desconto: n.querySelector('.disc')?.textContent?.trim() ?? null,
      titulo: n.querySelector('.title')?.textContent?.trim() ?? null,
      // O crédito precisa estar DENTRO da área da foto, não flutuando no corpo.
      dentroDaFoto: (() => {
        const c = n.querySelector('.cred-foto');
        const t = n.querySelector('.thumb');
        if (!c || !t) return null;
        const a = c.getBoundingClientRect();
        const r = t.getBoundingClientRect();
        return a.top >= r.top - 1 && a.bottom <= r.bottom + 1 && a.left >= r.left - 1 && a.right <= r.right + 1;
      })(),
    })),
  );

await p.goto(`${BASE}/home`);
await p.waitForSelector('#trilhoRecentes .card', { timeout: 20000 });
const home = await leCartoes('#trilhoRecentes .card');

await p.goto(`${BASE}/busca?sort=recent`);
await p.waitForSelector('#grid .card', { timeout: 20000 });
const busca = await leCartoes('#grid .card');

const resumo = (rot, cs) => ({
  onde: rot,
  cartoes: cs.length,
  comCredito: cs.filter((c) => c.credito).length,
  comDesconto: cs.filter((c) => c.desconto).length,
  creditoForaDaFoto: cs.filter((c) => c.dentroDaFoto === false).length,
  // id cru de fonte na tela é o bug de rótulo que a home tinha sozinha
  fonteCrua: [...new Set(cs.map((c) => c.fonte).filter((f) => f && /^[a-z]+$/.test(f)))],
});
console.log(JSON.stringify([resumo('home', home), resumo('busca', busca)], null, 2));

// Quantos lotes a API de fato manda com leiloeiro. Exigir crédito sem olhar isso
// reprova comportamento correto: os 24 mais recentes podem ser todos do Leilo,
// que não publica leiloeiro nenhum.
const comLeiloeiro = await p.evaluate(async () => {
  const d = await (await fetch('/api/home')).json();
  return (d.recentes ?? []).filter((l) => l.auctioneer_name).length;
});

const falhas = [];
if (!home.length) falhas.push('home não renderizou cartão');
if (comLeiloeiro && resumo('home', home).comCredito < comLeiloeiro) {
  falhas.push(`home: ${comLeiloeiro} lotes têm leiloeiro na API e só ${resumo('home', home).comCredito} mostram crédito`);
}
// O cartão vive em cartao.css agora: se o arquivo não for carregado, a marcação
// continua lá e o estilo some — nenhuma asserção de conteúdo perceberia.
const cartaoEstilizado = await p.evaluate(() => {
  const t = document.querySelector('.card .thumb');
  return t ? getComputedStyle(t).position === 'absolute' || getComputedStyle(t).position === 'relative' : false;
});
if (!cartaoEstilizado) falhas.push('cartao.css não foi aplicado (a .thumb perdeu o position)');
if (home.some((c) => c.dentroDaFoto === false)) falhas.push('home: crédito fora da área da foto');
if (resumo('home', home).fonteCrua.length) falhas.push(`home: id de fonte cru na tela: ${resumo('home', home).fonteCrua}`);
if (resumo('busca', busca).fonteCrua.length) falhas.push(`busca: id de fonte cru na tela: ${resumo('busca', busca).fonteCrua}`);

console.log(falhas.length ? `\nFALHOU:\n- ${falhas.join('\n- ')}` : '\nOK: home e busca com o mesmo cartão.');
await b.close();
process.exit(falhas.length ? 1 : 0);
