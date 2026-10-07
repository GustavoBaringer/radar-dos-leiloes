import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { getLot, searchLots, searchLotsMapa } from '../src/core/repo.js';
import { pool } from '../src/core/db.js';
import { parseSearchInput, safePositiveId } from '../src/core/request-bounds.js';

/**
 * Harness read-only do backend real: usa os handlers/repos sem iniciar server.ts.
 * Não inclui OIDC nem decoração por conta; o endpoint normal na porta 4500 pode
 * responder 401 sem autenticação e não é o alvo deste teste. O listener é sempre
 * loopback/porta efêmera; não iniciar worker, túnel ou processos existentes.
 */

const OUTPUT_DIR = '/tmp/opencode';
const BEFORE_PATH = `${OUTPUT_DIR}/radar-classificacao-before.json`;
const BASELINE_PATH = `${OUTPUT_DIR}/radar-search-fixtures-before.json`;
const AFTER_PATH = `${OUTPUT_DIR}/radar-search-after.json`;
const PAGE_SIZE = 24;
const VEHICLE_TYPES = ['carro', 'picape', 'suv'];
const DOC_TYPES = ['conservado', 'recuperado_financiamento', 'judicial'];
const EXCLUDED_IDS = [
  10611, 9300, 9425, 9700, 9711, 9794, 9883, 10050, 9276, 628762,
];
const PERSISTED_EXPECTATIONS: Record<number, { vehicle_type?: string; doc_type?: string }> = {
  10611: { vehicle_type: 'picape', doc_type: 'sucata' },
  9300: { vehicle_type: 'nautico' },
  9425: { vehicle_type: 'moto' },
  628762: { vehicle_type: 'maquina' },
};

type SafeLot = { id: number; asset_type: string; vehicle_type: string | null; doc_type: string | null };
type SearchResult = {
  total: number;
  page: number;
  pageSize: number;
  items: Array<Record<string, unknown> & SafeLot>;
};

function safeLot(lot: Record<string, unknown>): SafeLot {
  return {
    id: Number(lot.id),
    asset_type: String(lot.asset_type ?? ''),
    vehicle_type: typeof lot.vehicle_type === 'string' ? lot.vehicle_type : null,
    doc_type: typeof lot.doc_type === 'string' ? lot.doc_type : null,
  };
}

async function writeBaseline(): Promise<SafeLot[]> {
  const input = JSON.parse(await readFile(BEFORE_PATH, 'utf8')) as Array<Record<string, unknown>>;
  const required = new Set([10611, 9300, 9425, 9700, 9711, 9794, 9883, 10050, 9276, 628762]);
  const selected = input.filter((row) => required.has(Number(row.id))).map((row) => ({
    id: Number(row.id),
    asset_type: String(row.asset ?? ''),
    vehicle_type: typeof row.vehicle === 'string' ? row.vehicle : null,
    doc_type: typeof row.doc === 'string' ? row.doc : null,
  }));
  const ids = new Set(selected.map((lot) => lot.id));
  for (const id of required) assert.ok(ids.has(id), `baseline anterior não contém o exemplar ${id}`);
  assert.equal(selected.find((lot) => lot.id === 9300)?.vehicle_type, 'carro');
  assert.equal(selected.find((lot) => lot.id === 9425)?.vehicle_type, 'carro');
  assert.equal(selected.find((lot) => lot.id === 9276)?.vehicle_type, 'carro');
  assert.equal(selected.find((lot) => lot.id === 628762)?.vehicle_type, 'carro');
  const expectedAfter = [
    { id: 10611, doc_type: 'sucata', vehicle_type: 'picape' },
    { id: 9300, vehicle_type: 'nautico' },
    ...[9425, 9700, 9711, 9794, 9883, 10050].map((id) => ({ id, vehicle_type: 'moto' })),
    { id: 9276, vehicle_type: 'caminhao' },
    { id: 628762, vehicle_type: 'maquina' },
  ];
  await writeFile(BASELINE_PATH, `${JSON.stringify({ source: 'radar-classificacao-before.json', lots: selected, expectedAfter }, null, 2)}\n`);
  return selected;
}

function params(page?: number): URLSearchParams {
  const query = new URLSearchParams({ yearMin: '2021', pageSize: String(PAGE_SIZE) });
  query.set('vehicleType', VEHICLE_TYPES.join(','));
  query.set('docType', DOC_TYPES.join(','));
  if (page !== undefined) query.set('page', String(page));
  return query;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as T;
  assert.equal(response.status, 200, `HTTP ${response.status} em ${new URL(url).pathname}`);
  return body;
}

function assertSearchPredicates(result: SearchResult, page: number, expectedTotal?: number): void {
  assert.equal(result.page, page);
  assert.equal(result.pageSize, PAGE_SIZE);
  assert.ok(Number.isSafeInteger(result.total) && result.total >= 0, 'total precisa ser inteiro íntegro');
  if (expectedTotal !== undefined) assert.equal(result.total, expectedTotal, 'total mudou entre páginas');
  assert.ok(Array.isArray(result.items) && result.items.length <= PAGE_SIZE);
  for (const lot of result.items) {
    assert.ok(Number.isSafeInteger(lot.id) && lot.id > 0, 'DTO precisa expor id positivo');
    assert.equal(lot.asset_type, 'veiculo');
    assert.ok(VEHICLE_TYPES.includes(lot.vehicle_type ?? ''), `vehicle_type fora do filtro: ${lot.id}`);
    assert.ok(DOC_TYPES.includes(lot.doc_type ?? ''), `doc_type fora do filtro: ${lot.id}`);
    assert.ok(typeof lot.year_model === 'number' && lot.year_model >= 2021, `year_model fora do filtro: ${lot.id}`);
    for (const forbidden of ['raw', 'raw_text', 'external', 'external_id', 'tenant', 'lat', 'lon']) {
      assert.equal(Object.hasOwn(lot, forbidden), false, `DTO não deve expor ${forbidden}`);
    }
  }
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  let baseline: SafeLot[] = [];
  let origin: string | null = null;
  let searchPages: SafeLot[] = [];
  let targetedLots: SafeLot[] = [];
  let pageTotal: number | null = null;
  let pageCount = 0;
  let mapTotal: number | null = null;
  let hiluxSearch: { total: number; lots: SafeLot[] } | null = null;

  // Sem middleware/auth/decoradores de conta: em cada rota, mesma chamada e
  // parser usados pelo backend público, sem importar src/server.ts.
  app.get('/api/search', async (req) => searchLots(parseSearchInput(req.query)));
  app.get('/api/search/mapa', async (req) => searchLotsMapa(parseSearchInput(req.query)));
  app.get('/api/lot/:id', async (req, reply) => {
    const id = safePositiveId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'id inválido' });
    const lot = await getLot(id);
    if (!lot) return reply.code(404).send({ error: 'lote não encontrado' });
    return lot;
  });

  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
    baseline = await writeBaseline();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const bound = new URL(address);
    assert.equal(bound.hostname, '127.0.0.1', 'harness deve ficar restrito a loopback');
    origin = bound.origin;

    const pageTwo = await getJson<SearchResult>(`${origin}/api/search?${params(2)}`);
    assertSearchPredicates(pageTwo, 2);
    pageTotal = pageTwo.total;

    assert.ok(pageTotal <= PAGE_SIZE * 100, 'resultado excede limite de paginação validado');
    const all = new Set<number>();
    const allSafe: SafeLot[] = [];
    const pages = Math.max(1, Math.ceil(pageTotal / PAGE_SIZE));
    for (let page = 1; page <= pages; page++) {
      const result: SearchResult = await getJson<SearchResult>(`${origin}/api/search?${params(page)}`);
      assertSearchPredicates(result, page, pageTotal);
      for (const lot of result.items) {
        assert.equal(all.has(lot.id), false, `ID repetido entre páginas: ${lot.id}`);
        all.add(lot.id);
        allSafe.push(safeLot(lot));
      }
    }
    assert.equal(all.size, pageTotal, 'quantidade de IDs paginados precisa igualar total');
    assert.equal(allSafe.length, pageTotal);
    pageCount = pages;
    searchPages = allSafe;

    const map = await getJson<{ total: number }>(`${origin}/api/search/mapa?${params(2)}`);
    mapTotal = map.total;
    assert.equal(mapTotal, pageTotal, 'total do mapa diverge do total da busca');

    const absent = new Set(all);
    for (const id of EXCLUDED_IDS) assert.equal(absent.has(id), false, `lote malclassificado ${id} ainda aparece no filtro de veículos leves`);

    const detailById = new Map<number, SafeLot>();
    for (const id of Object.keys(PERSISTED_EXPECTATIONS).map(Number)) {
      const lot: Record<string, unknown> = await getJson<Record<string, unknown>>(`${origin}/api/lot/${id}`);
      assert.equal(lot.id, id);
      const safe = safeLot(lot);
      detailById.set(id, safe);
      const expected = PERSISTED_EXPECTATIONS[id];
      if (expected.vehicle_type) assert.equal(safe.vehicle_type, expected.vehicle_type, `vehicle_type persistido do lote ${id}`);
      if (expected.doc_type) assert.equal(safe.doc_type, expected.doc_type, `doc_type persistido do lote ${id}`);
      assert.equal(safe.asset_type, 'veiculo', `asset_type persistido do lote ${id}`);
    }
    targetedLots = [...detailById.values()];

    const hiluxQuery = new URLSearchParams({ q: 'Hilux', docType: 'sucata', vehicleType: 'picape', includeEnded: 'true', pageSize: '24' });
    const hiluxResult = await getJson<SearchResult>(`${origin}/api/search?${hiluxQuery}`);
    hiluxSearch = { total: hiluxResult.total, lots: hiluxResult.items.map(safeLot) };
    assert.ok(hiluxResult.items.some((lot) => lot.id === 10611), 'busca Hilux + sucata deve incluir ID 10611');

    const after = {
      query: { yearMin: 2021, vehicleType: VEHICLE_TYPES, docType: DOC_TYPES, pageSize: PAGE_SIZE },
      total: pageTotal,
      pageCount,
      mapTotal,
      lots: searchPages,
      details: targetedLots,
      hiluxQuery: hiluxSearch,
      excludedIds: EXCLUDED_IDS,
      baselineCount: baseline.length,
    };
    await writeFile(AFTER_PATH, `${JSON.stringify(after, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, total: pageTotal, pages: pageCount, mapTotal, baseline: BASELINE_PATH, after: AFTER_PATH }));
  } finally {
    // Sempre capturar uma saída segura (somente id/tipo/doc), inclusive quando
    // uma assertion pós-backfill falhar no estado pré-correção.
    try {
      await writeFile(AFTER_PATH, `${JSON.stringify({
        query: { yearMin: 2021, vehicleType: VEHICLE_TYPES, docType: DOC_TYPES, pageSize: PAGE_SIZE },
        total: pageTotal,
        pageCount,
        mapTotal,
        lots: searchPages,
        details: targetedLots,
        hiluxQuery: hiluxSearch,
        excludedIds: EXCLUDED_IDS,
        baselineCount: baseline.length,
      }, null, 2)}\n`);
    } finally {
      try {
        if (origin) await app.close();
      } finally {
        await pool.end();
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error('Falha no teste read-only de classificação real:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
