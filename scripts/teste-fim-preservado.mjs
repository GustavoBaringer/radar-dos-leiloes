/**
 * O fim publicado não pode ser destruído por um NULL posterior da fonte — mas
 * também não pode atravessar para outro leilão. Três casos, um por linha de
 * decisão do COALESCE no upsert.
 */
import { spawnSync } from 'node:child_process';

const sql = (q) => spawnSync('docker', ['exec', 'leilao-db', 'psql', '-U', 'leilao', '-d', 'leilao', '-t', '-A', '-c', q], { encoding: 'utf8' }).stdout.trim();

const FONTE = '__teste_fim__';
const INICIO = '2026-10-01 17:00:00+00';
const FIM = '2026-10-01 18:30:00+00';
const OUTRO_INICIO = '2026-11-20 17:00:00+00';

// A fonte precisa existir: lots.source_id tem chave estrangeira para sources.
sql(`INSERT INTO sources (id,name,method,tier,enabled) VALUES ('${FONTE}','teste','api',1,false) ON CONFLICT (id) DO NOTHING`);
sql(`DELETE FROM lots WHERE source_id='${FONTE}'`);

const { upsertLots } = await import('../src/core/repo.ts');
const base = (extra) => ({
  sourceId: FONTE, externalId: 'L1', lotUrl: 'https://exemplo/x', titleRaw: 'FIAT/UNO MILLE',
  closingModel: 'timer_por_lote', sourceTz: 'UTC', status: 'aberto', photos: [], ...extra,
});

let falhas = 0;
const conferir = (nome, esperado) => {
  const real = sql(`SELECT COALESCE(to_char(auction_end_utc AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),'NULL') FROM lots WHERE source_id='${FONTE}'`);
  const ok = real === esperado;
  if (!ok) falhas++;
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${nome}: esperado ${esperado}, obtido ${real}`);
};

await upsertLots([base({ auctionStartUtc: new Date(INICIO), auctionEndUtc: new Date(FIM) })]);
conferir('1. fonte publica o fim', '2026-10-01 18:30');

// O leilão entrou ao vivo e a fonte parou de publicar o fim.
await upsertLots([base({ auctionStartUtc: new Date(INICIO), auctionEndUtc: null })]);
conferir('2. fim NULO no mesmo leilao -> preserva', '2026-10-01 18:30');

// Relistagem: mesmo id, leilão novo (2ª praça). O prazo velho não pode viajar.
await upsertLots([base({ auctionStartUtc: new Date(OUTRO_INICIO), auctionEndUtc: null })]);
conferir('3. fim NULO em leilao NOVO -> descarta', 'NULL');

// A fonte voltando a publicar sempre vence.
await upsertLots([base({ auctionStartUtc: new Date(OUTRO_INICIO), auctionEndUtc: new Date('2026-11-20 19:00:00+00') })]);
conferir('4. fonte republica -> vence', '2026-11-20 19:00');

sql(`DELETE FROM lots WHERE source_id='${FONTE}'`);
sql(`DELETE FROM sources WHERE id='${FONTE}'`);
console.log(falhas ? `\n${falhas} FALHA(S)` : '\n4/4 passaram');
process.exit(falhas ? 1 : 0);
