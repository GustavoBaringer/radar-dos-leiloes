/**
 * Hastá Pública: "Próxima data" do card NÃO é o fim do lance.
 *
 * O caso que motivou isto é real e tem data: em 13/10/2026 o lote 104282
 * (Mercedes GLA 250) foi encerrado no Radar às 00:00 — a "Próxima data" do card
 * é `DD/MM/YYYY 00:00` quando o site só tem o dia — enquanto a página do lote
 * publicava "Encerra em 13/10/2026 14:01 (horário previsto)" com status
 * "Recebendo Propostas". Quatorze horas de leilão ativo mostradas como mortas.
 *
 * A propriedade que não pode quebrar: um card SEM horário publicado nunca pode
 * virar prazo de encerramento. É a mesma disciplina do `sem_licitante` do
 * soleon — é assim que lote vivo some da busca em silêncio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cards, proximaData } from '../src/connectors/hastapublica.js';
import { VERIFICADORES } from '../src/infra/verification/verifiers.js';

// Card COMPACTO de propósito: com o rótulo e o <dd> vizinhos, o regex guloso
// passava por cima e lia o <dd> do Lance Inicial como se fosse a data.
const HOME = (data: string, fortes = '<strong>Judicial | Em andamento</strong>') => `
<div class="imgLoteSmall">
  <a href="https://www.hastapublica.com.br/lote/104282/Veiculo-Mercedes-Benz-GLA-250-20192019">
    <img src="https://exemplo.test/foto.jpg">
  </a>
  <dl><dt><small>São Carlos/SP</small></dt></dl>
  ${fortes}
  <dl><dt><small>Próxima data</small></dt><dd>${data}</dd></dl>
  <dl><dt><small>Lance Inicial<small>(R$) </small></small></dt><dd>122.000,00&nbsp;</dd></dl>
  <dd><a href="/lote/104282/x">Mercedes-Benz GLA 250</a></dd>
</div>`;

test('data sem hora publicada NÃO vira fim de leilão', () => {
  const soDia = cards(HOME('13/10/2026 00:00'));
  assert.equal(soDia.length, 1);
  assert.equal(soDia[0].auctionEndUtc, null, 'meia-noite do card não pode encerrar lote');
  assert.equal(soDia[0].closingModel, 'timer_por_lote', 'o modelo de encerramento não muda');
  assert.equal(soDia[0].minBid, 122000, 'o valor do lance não pode virar a data do card');

  // Com horário publicado, o valor continua sendo usado — é a sessão mesmo.
  const comHora = cards(HOME('22/02/2027 16:30'));
  assert.equal(comHora[0].auctionEndUtc?.toISOString(), '2027-02-22T19:30:00.000Z', '16:30 de Brasília = 19:30Z');
  assert.equal(comHora[0].minBid, 122000);
});

test('proximaData distingue dia de horário e recusa lixo', () => {
  assert.equal(proximaData('').fim, null);
  // Sem hora e com o 00:00 de preenchimento do site são a mesma coisa.
  assert.equal(proximaData('13/10/2026').temHora, false);
  assert.equal(proximaData('13/10/2026 00:00').temHora, false, 'meia-noite é preenchimento, não horário publicado');
  assert.equal(proximaData('13/10/2026').fim?.toISOString(), '2026-10-13T03:00:00.000Z');
  assert.equal(proximaData('13/10/2026 00:01').temHora, true, 'meia-noite e um é horário publicado');
  assert.equal(proximaData('13/10/2026 14:01').temHora, true);
  assert.equal(proximaData('13/10/2026 14:01').fim?.toISOString(), '2026-10-13T17:01:00.000Z');
  for (const nulo of [null, undefined, 'breve', '99/99/9999 10:00']) {
    assert.equal(proximaData(nulo).fim, null, `não pode inventar data a partir de ${nulo}`);
  }
});

test('o estado vem do <strong> que carrega o vocabulário, não do primeiro da janela', () => {
  // Rótulo ("Judicial") ANTES do estado: o take-first pegava o errado.
  const comRotulo = cards(HOME('14/10/2026 00:00', '<strong>Judicial</strong><strong>Judicial | Em andamento</strong>'));
  assert.equal(comRotulo[0].status, 'aberto');
  assert.equal(comRotulo[0].docType, 'judicial');

  // Nenhum <strong> com vocabulário de estado: sem_data, desfecho conservador.
  const semEstado = cards(HOME('14/10/2026 00:00', '<strong>Judicial</strong>'));
  assert.equal(semEstado[0].status, 'sem_data');
  assert.equal(semEstado[0].auctionEndUtc, null);
});

/* ---------------------------------------------------------------- verificador */

const PAGINA = (estado: string, encerra = '13/10/2026 14:01') => `
<html><body>
  <link rel="canonical" href="https://www.hastapublica.com.br/lote/104282/Veiculo-GLA">
  <dt>Status do Item</dt>
  <dd class="badge bg-success" style="color:#fff">${estado}</dd>
  <div class="card" style="display:none">
    <dl><dt>Encerra em</dt><dd class="destaquetexto ">${encerra} <small>(horário previsto)</small></dd></dl>
  </div>
  <dt>Abertura em</dt><dd>10/07/2026</dd>
</body></html>`;

/** Medido em 104691/104692 em 13/10/2026: HTTP 200, "Nenhum lote para exibir". */
const SEM_LOTE = '<html><body><link rel="canonical" href="/">Nenhum lote para exibir.</body></html>';

const verifica = (html: string, status = 200) => VERIFICADORES.hastapublica.verificar(
  'www.hastapublica.com.br',
  [{ id: 1, externalId: '104282', lotUrl: 'https://www.hastapublica.com.br/lote/104282/x', categoria: null }],
  async () => ({ status, body: html }) as any,
);

test('o verificador lê o status da página e devolve o prazo real da origem', async () => {
  const r = await verifica(PAGINA('Recebendo Propostas'));
  const v = r.get(1)!;
  assert.equal(v.veredito, 'aberto');
  assert.equal(v.sinal, 'Recebendo Propostas');
  assert.equal(v.fimUtc, '2026-10-13T17:01:00.000Z', '14:01 de Brasília = 17:01Z');
});

test('estado fechado fecha; "sem licitante" decide pelo prazo, não pelo rótulo', async () => {
  assert.equal((await verifica(PAGINA('Arrematado'))).get(1)!.veredito, 'encerrado');
  assert.equal((await verifica(PAGINA('Leilão Cancelado'))).get(1)!.veredito, 'encerrado');

  // Prazo no futuro ainda pode reabrir (2ª praça): agendado, NÃO encerrado.
  const futuro = new Date(Date.now() + 86_400_000);
  const dd = String(futuro.getUTCDate()).padStart(2, '0');
  const mm = String(futuro.getUTCMonth() + 1).padStart(2, '0');
  const semLicitanteFuturo = await verifica(PAGINA('Sem Licitante', `${dd}/${mm}/${futuro.getUTCFullYear()} 10:00`));
  assert.equal(semLicitanteFuturo.get(1)!.veredito, 'agendado');

  const semLicitantePassado = await verifica(PAGINA('Sem Licitante', '01/01/2026 10:00'));
  assert.equal(semLicitantePassado.get(1)!.veredito, 'encerrado');
});

test('o verificador nunca adivinha: página sem estado, erro e 404', async () => {
  // Página do lote SEM o id E com o marcador da fonte: o item saiu do leilão,
  // e sem esta regra o lote reaberto nunca fecharia.
  assert.equal((await verifica(SEM_LOTE)).get(1)!.veredito, 'sumiu');
  // Página genérica 200 sem o id e SEM o marcador: nunca adivinhar. É o que uma
  // página de erro ou de WAF traria, e encerrar lote vivo por isso é o pior erro.
  assert.equal((await verifica('<html><body><h1>Manutenção</h1></body></html>')).get(1)!.veredito, 'indeterminado');
  // Página que É do lote mas sem "Status do Item": indeterminado, nunca fecha.
  assert.equal((await verifica('<html><body>sem nada</body></html>')).get(1)!.veredito, 'indeterminado');
  assert.equal((await verifica(PAGINA('Recebendo Propostas'), 503)).get(1)!.veredito, 'indeterminado');
  assert.equal((await verifica('', 404)).get(1)!.veredito, 'sumiu');
  assert.equal((await verifica('', 410)).get(1)!.veredito, 'sumiu');
  const semUrl = await VERIFICADORES.hastapublica.verificar('www.hastapublica.com.br', [{ id: 9, externalId: null, lotUrl: null, categoria: null }]);
  assert.equal(semUrl.get(9)!.veredito, 'indeterminado');
});

test('hastapublica tem verificador registrado', () => {
  assert.ok('hastapublica' in VERIFICADORES, 'sem verificador, nada desmente o relógio');
});
