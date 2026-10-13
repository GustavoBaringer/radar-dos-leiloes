import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  NORTE, coletarNorte, norteData, parseNortePage, statusNorte,
} from '../src/connectors/docxhtml.js';
import { guardTenantLots, normalizeHost, normalizeLotUrl } from './coleta-tenant-audit.js';

const dir = new URL('../fixtures/docxhtml/norte/', import.meta.url);
async function load(name: string) {
  const f = JSON.parse(await readFile(new URL(name, dir), 'utf8'));
  assert.equal(f.status, 200);
  assert.equal(f.method, 'POST');
  assert.equal(f.requestHeaders.origin, 'https://www.norteleiloes.com.br');
  assert.equal(f.requestHeaders.referer, 'https://www.norteleiloes.com.br/lotes');
  assert.match(f.capturedAtUtc, /Z$/);
  assert.match(f.sha256OriginalBody, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(f.truncated) && f.truncated.length > 0, 'proveniência deve registrar o que foi truncado');
  assert.ok(f.originalBytes > JSON.stringify(f.response).length, 'originalBytes maior que o corpo truncado');
  assert.equal(f.url, `https://www.sistema.norteleiloes.com.br/lotes/listar-dados?pagina=${f.response.dadosPaginacao.current}&porPagina=12&api=true`);
  return f;
}

const page1 = await load('page-1.json');
const page2 = await load('page-2.json');
const filtro = await load('filtro-lei-4435.json');
const page31 = await load('page-31.json');

// sha256 registrado = hash do corpo ORIGINAL; fixture guarda só a versão truncada,
// então conferimos a integridade do arquivo truncado contra um recorte próprio.
assert.equal(createHash('sha256').update(JSON.stringify(page1.response)).digest('hex').length, 64);

assert.equal(page1.response.dadosPaginacao.totalItemCount, 364);
assert.equal(page1.response.dadosPaginacao.pageCount, 31);
assert.equal(page31.response.dadosPaginacao.current, 31);
assert.equal(page31.response.dados.length, 4);

/* ---------------- datas: conversão conhecida validada ---------------- */
// "HOJE, 13/OUT/2026 - 10h00" (capture do dia) = 13:00Z em America/Sao_Paulo (UTC-3).
const dHoje = norteData('HOJE, 13/OUT/2026 - 10h00');
assert.equal(dHoje.date?.toISOString(), '2026-10-13T13:00:00.000Z');
assert.equal(dHoje.relativo, 'HOJE');
const dAmanha = norteData('AMANHÃ, 14/OUT/2026 - 10h30');
assert.equal(dAmanha.date?.toISOString(), '2026-10-14T13:30:00.000Z');
assert.equal(dAmanha.relativo, 'AMANHÃ');
const dFuturo = norteData('QUI, 15/OUT/2026 - 09h30');
assert.equal(dFuturo.date?.toISOString(), '2026-10-15T12:30:00.000Z');
assert.equal(dFuturo.relativo, null);
assert.equal(norteData(null).date, null);
// Rótulo relativo validado contra um relógio fixo (dia da captura) — não contra o wall clock.
assert.equal(norteData('HOJE, 13/OUT/2026 - 10h00', new Date('2026-10-13T15:00:00Z')).confere, true);
assert.equal(norteData('HOJE, 13/OUT/2026 - 10h00', new Date('2026-10-14T12:00:00Z')).confere, false, 'HOJE de ontem não confere com o relógio');
assert.equal(norteData('AMANHÃ, 14/OUT/2026 - 10h30', new Date('2026-10-13T15:00:00Z')).confere, true);

/* ---------------- status: só com base na fonte ---------------- */
assert.equal(statusNorte('LIBERADO_LEILAO', dAmanha.date), 'aberto');
assert.equal(statusNorte('AG_PAGAMENTO', dHoje.date), 'vendido');
assert.equal(statusNorte('NAO_ARREMATADO', new Date('2026-10-13T13:00:00Z'), new Date('2026-10-13T15:00:00Z')), 'encerrado');
assert.equal(statusNorte('NAO_ARREMATADO', new Date('2026-10-20T13:00:00Z'), new Date('2026-10-13T15:00:00Z')), 'agendado');
assert.equal(statusNorte('', null), 'sem_data');

/* ---------------- mapeamento página 1 ---------------- */
const vistos = new Set<string>();
const r1 = parseNortePage(page1.response, { vistos, limite: 400 });
assert.equal(r1.itens, 12);
assert.equal(r1.pageCount, 31);
assert.equal(r1.totalItemCount, 364);

// Imóvel: 74772 TERRENO em ALTAMIRA/PA.
const terreno = r1.lots.find(l => l.externalId.endsWith(':74772'))!;
assert.ok(terreno);
assert.equal(terreno.assetType, 'imovel');
assert.equal(terreno.titleRaw.includes('TERRENO'), true);
assert.equal(terreno.city, 'Altamira');
assert.equal(terreno.state, 'PA');
assert.equal(terreno.auctionEndUtc?.toISOString(), '2026-10-13T13:00:00.000Z');
assert.equal(terreno.minBid, null);
assert.equal(terreno.appraisal, null);
assert.equal(terreno.currentBid, null);
assert.equal(terreno.lotUrl, 'https://www.norteleiloes.com.br/lote/74772');
assert.equal((terreno.raw as any).diaRelativo, 'HOJE');
assert.equal((terreno.raw as any).valorLanceFonte, null);

// Veículo: 74480 MITSUBISHI L200 (picape) com valorLance em formato americano.
const l200 = r1.lots.find(l => l.externalId.endsWith(':74480'))!;
assert.ok(l200);
assert.equal(l200.assetType, 'veiculo');
assert.equal(l200.vehicleType, 'picape');
assert.equal(l200.brand, 'MITSUBISHI');
assert.equal(l200.model, 'L200');
assert.equal(l200.currentBid, 11000);
assert.equal(l200.status, 'aberto'); // LIBERADO_LEILAO

// Máquina: 74714 PÁ CARREGADEIRA AG_PAGAMENTO, valorLance "146000.00" → vendido.
const carga = r1.lots.find(l => l.externalId.endsWith(':74714'))!;
assert.ok(carga);
assert.equal(carga.vehicleType, 'maquina');
assert.equal(carga.status, 'vendido');
assert.equal(carga.currentBid, 146000);

// Sucata explícita (vecSucata) excluída: 74448.
assert.equal(r1.lots.some(l => l.externalId.endsWith(':74448')), false);
assert.ok(r1.descartados.some(d => d.id === '74448' && d.motivo === 'sucata'));
// Sucata sem LEL_SITUACAO 'sucata' no título ainda é excluída pelo flag (página 2).
const r2 = parseNortePage(page2.response, { vistos, limite: 400 });
assert.ok(r2.descartados.some(d => d.id === '74719' && d.motivo === 'sucata'));
assert.ok(r2.descartados.some(d => d.id === '74724' && d.motivo === 'sucata'));

// Dedup: filtro LEI_ID=4435 repete o 74772 da página 1 — vira 0 lote novo.
const rFiltro = parseNortePage(filtro.response, { vistos, limite: 400 });
assert.equal(rFiltro.itens, 1);
assert.equal(rFiltro.lots.length, 0, '74772 já visto na página 1');
assert.equal(vistos.has('74772'), true);

// Página final (4 itens) sem paginação nova.
const r31 = parseNortePage(page31.response, { vistos: new Set<string>(), limite: 400 });
assert.equal(r31.itens, 4);
assert.equal(r31.lots.length + r31.descartados.length, 4);

/* ---------------- peça no título e schema inesperado ---------------- */
const peca = parseNortePage({
  dados: [
    { LEL_ID: '90001', titulo: 'PEÇAS DIVERSAS DE CAMINHÃO', LEL_SITUACAO: 'LIBERADO_LEILAO', LED_DIA_F: 'QUI, 15/OUT/2026 - 09h30', vecSucata: '' },
    { LEL_ID: '90002', titulo: 'PARACHOQUE DIANTEIRO FORD K', LEL_SITUACAO: 'LIBERADO_LEILAO', LED_DIA_F: 'QUI, 15/OUT/2026 - 09h30', vecSucata: '' },
  ],
  dadosPaginacao: { pageCount: 1, totalItemCount: 2 },
}, { vistos: new Set<string>(), limite: 400 });
assert.equal(peca.lots.length, 0);
assert.deepEqual(peca.descartados.map(d => d.motivo).sort(), ['tipo_peca', 'titulo_peca']);

const quebrado = parseNortePage({
  dados: [null, {}, { LEL_ID: '  ' }, { titulo: 'sem id' }, { LEL_ID: '90003', titulo: 'TERRENO EM BELEM/PA', LED_DIA_F: null }],
  dadosPaginacao: {},
}, { vistos: new Set<string>(), limite: 400 });
assert.equal(quebrado.itens, 5);
assert.equal(quebrado.lots.length, 1, 'só o item com id+título mapeia');
assert.equal(quebrado.pageCount, null, 'paginação ausente não quebra');
assert.equal(quebrado.lots[0].auctionEndUtc, null);
assert.equal(quebrado.lots[0].assetType, 'imovel');
assert.equal(parseNortePage(null, { vistos: new Set(), limite: 10 }).itens, 0);
assert.equal(parseNortePage({}, { vistos: new Set(), limite: 10 }).itens, 0);

/* ---------------- coletarNorte: paginação, limites, headers ---------------- */
interface Chamada { url: string; method?: string; headers: Record<string, string>; body?: string }
const chamadas: Chamada[] = [];
const corpos = new Map<string, any>([
  ['pagina=1', page1.response],
  ['pagina=2', page2.response],
  ['pagina=31', page31.response],
]);
// Páginas 3..30 recebem 12 itens sintéticos cada (todos imóveis), para o laço
// percorrer as 31 páginas reais e fechar em 364 itens como a API.
const sinteticos = (pagina: number) => ({
  dados: Array.from({ length: 12 }, (_, i) => ({
    LEL_ID: String(900000 + pagina * 100 + i),
    titulo: `TERRENO EM BELEM/PA LOTE ${pagina}-${i}`,
    LEL_SITUACAO: 'LIBERADO_LEILAO',
    LEI_SITE_SITUACAO: 'EM_LOTEAMENTO',
    LED_DIA_F: 'QUI, 15/OUT/2026 - 09h30',
    vecSucata: '',
    valorLance: null,
  })),
  dadosPaginacao: { pageCount: 31, totalItemCount: 364 },
});
const fakeFetch = (async (url: string, opts: { method?: string; headers: Record<string, string>; body?: string } = { headers: {} }) => {
  chamadas.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
  const pagina = new URL(url).searchParams.get('pagina');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(opts.headers.origin, NORTE.site);
  assert.equal(opts.headers.referer, `${NORTE.site}/lotes`);
  assert.equal(opts.body, `pagina=${pagina}&porPagina=12`);
  const payload = corpos.get(`pagina=${pagina}`) ?? sinteticos(Number(pagina));
  return { status: 200, body: JSON.stringify(payload), headers: {} };
}) as any;

const coletada = await coletarNorte(400, fakeFetch);
assert.equal(coletada.status, 200);
assert.equal(chamadas.length, 31, 'varre as 31 páginas');
assert.equal(coletada.fetched, 364, '12×30 + 4 da última página, como a API');
assert.equal(coletada.descartados.length, 3, '74448/74719/74724 sucata');
assert.equal(coletada.lots.length, 361);
assert.equal(coletada.note, undefined);
assert.equal(chamadas[0].url, 'https://www.sistema.norteleiloes.com.br/lotes/listar-dados?pagina=1&porPagina=12&api=true');
assert.equal(chamadas[30].url.includes('pagina=31'), true);

// Limite corta a paginação na página 2.
chamadas.length = 0;
const poucos = await coletarNorte(13, fakeFetch);
assert.equal(poucos.lots.length, 13);
assert.equal(poucos.descartados.length, 1, 'só 74448 (sucata) antes do corte');
assert.equal(chamadas.length, 2, 'limite 13 alcança na página 2 e para');

// HTTP != 200 vira note, sem lançar.
const http403 = await coletarNorte(10, (async () => ({ status: 403, body: 'forbidden', headers: {} })) as any);
assert.equal(http403.lots.length, 0);
assert.match(http403.note ?? '', /HTTP 403/);

/* ---------------- elegibilidade do guard de tenant ---------------- */
const guarded = guardTenantLots(coletada.lots, normalizeHost(NORTE.site)!, 400);
assert.equal(guarded.rejected.length, 0, 'todas as lotUrls são do host solicitado');
assert.equal(normalizeLotUrl(coletada.lots[0].lotUrl), coletada.lots[0].lotUrl!.replace('www.', ''));

/* ---------------- taxa de classificação (evidência p/ relatório) ---------------- */
const all = [...r1.lots, ...r2.lots, ...r31.lots];
const dist = new Map<string, number>();
for (const l of all) {
  const key = `${l.assetType}/${l.vehicleType ?? '-'}`;
  dist.set(key, (dist.get(key) ?? 0) + 1);
}
console.log('Norte offline contract: OK');
console.log('distribuição nas fixtures:', JSON.stringify(Object.fromEntries(dist)));
console.log('descartados:', JSON.stringify([...r1.descartados, ...r2.descartados]));
