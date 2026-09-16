
import { Worker } from 'bullmq';
import { getConnector, connectors } from '../connectors/index.js';
import { upsertLots, startRun, finishRun, ensureSources } from '../core/repo.js';
import { processarAposColeta } from '../core/pos-coleta.js';
import { query } from '../core/db.js';
import { rodarDescoberta } from '../core/descoberta.js';
import { encerrarLotes } from '../core/encerramento.js';
import {
  QUEUE_COLLECT, QUEUE_REFRESH, QUEUE_DISCOVER, CHANNEL_UPDATES, makeRedis,
  collectQueue, refreshQueue, discoverQueue, type CollectJob, type RefreshJob, type DiscoverJob,
} from './queues.js';

const publisher = makeRedis();

async function runCollect(sourceId: string, limit: number) {
  // startRun ANTES de validar a fonte: com o throw primeiro, um sourceId
  // errado não gerava linha nenhuma em collection_runs e sumia da tela.
  const runId = await startRun(sourceId, 'collect', limit);
  const connector = getConnector(sourceId);
  if (!connector) {
    await finishRun(runId, { ok: false, error: `fonte desconhecida: ${sourceId}` });
    throw new Error(`fonte desconhecida: ${sourceId}`);
  }
  try {
    const result = await connector.collect({ limit });
    // Zero lote com HTTP fora de 2xx é bloqueio, não catálogo vazio. Sem este
    // portão, 7 execuções históricas (301, 302, 400) gravaram ok=true e a tela
    // de cobertura mostrou "última coleta" recente escondendo a fonte caída.
    if (result.fetched === 0 && result.httpStatus != null && (result.httpStatus < 200 || result.httpStatus >= 300)) {
      const err: any = new Error(`${sourceId} devolveu HTTP ${result.httpStatus} sem nenhum lote`);
      err.httpStatus = result.httpStatus;
      throw err;
    }
    const { upserted, bidChanges, novos } = await upsertLots(result.lots);

    // Alertas só olham o que é NOVO, e o caminho é o mesmo do script de coleta.
    await processarAposColeta(novos, (payload) => publisher.publish(CHANNEL_UPDATES, JSON.stringify(payload)));
    await finishRun(runId, {
      ok: true,
      fetched: result.fetched,
      upserted,
      skipped: result.skipped,
      httpStatus: result.httpStatus,
    });
    if (bidChanges.length) {
      await publisher.publish(CHANNEL_UPDATES, JSON.stringify({ type: 'bids', changes: bidChanges }));
    }
    await publisher.publish(
      CHANNEL_UPDATES,
      JSON.stringify({ type: 'collect', sourceId, fetched: result.fetched, upserted, skipped: result.skipped }),
    );
    return { fetched: result.fetched, upserted, skipped: result.skipped };
  } catch (err: any) {
    // httpStatus no erro separa bloqueio (403/429) de falha de rede/DNS.
    await finishRun(runId, {
      ok: false,
      error: String(err?.message ?? err),
      httpStatus: Number(err?.httpStatus) || undefined,
    });
    throw err;
  }
}

/**
 * Refresh quente: só os lotes que encerram em menos de uma hora.
 * Fonte com timer por lote é a única em que isso muda alguma coisa,
 * então o refresh recoleta essas fontes com limite pequeno.
 */
async function runRefresh() {
  const hot = await query<{ source_id: string; n: number }>(`
    SELECT source_id, COUNT(*)::int AS n FROM lots
    WHERE closing_model = 'timer_por_lote'
      AND auction_end_utc IS NOT NULL
      AND auction_end_utc BETWEEN now() AND now() + interval '1 hour'
    GROUP BY 1`);
  if (!hot.length) return { hot: 0 };
  for (const row of hot) {
    await runCollect(row.source_id, 120);
  }
  return { hot: hot.reduce((a, b) => a + b.n, 0) };
}

/**
 * Encerramento a cada minuto.
 *
 * Fica num intervalo do próprio worker, não numa fila: é uma consulta curta com
 * índice, sem rede e sem risco de acumular fila. Um job repetido do BullMQ para
 * isto criaria entrada de fila por minuto — 1.440 por dia — para um trabalho
 * que na maior parte das vezes atualiza zero linha.
 *
 * O `travado` impede sobreposição: se uma varredura demorar mais que o minuto,
 * a seguinte espera em vez de rodar o mesmo UPDATE em paralelo.
 */
let travado = false;
async function cicloDeEncerramento() {
  if (travado) return;
  travado = true;
  try {
    const r = await encerrarLotes();
    if (r.porPrazo || r.porAusencia) {
      console.log(`[encerrar] prazo: ${r.porPrazo} · ausente na fonte: ${r.porAusencia}`);
    }
  } catch (e: any) {
    console.error('[encerrar] falhou:', e.message);
  } finally {
    travado = false;
  }
}
setInterval(cicloDeEncerramento, 60_000).unref();
// Roda na subida também: reiniciar o worker não deve deixar lote vencido
// esperando o primeiro minuto.
void cicloDeEncerramento();

await ensureSources();

new Worker<CollectJob>(
  QUEUE_COLLECT,
  async (job) => runCollect(job.data.sourceId, job.data.limit),
  { connection: makeRedis(), concurrency: 2 },
).on('failed', (job, err) => console.error(`[collect] ${job?.data.sourceId} falhou:`, err.message));

new Worker<RefreshJob>(QUEUE_REFRESH, async () => runRefresh(), { connection: makeRedis(), concurrency: 1 }).on(
  'failed',
  (_job, err) => console.error('[refresh] falhou:', err.message),
);

new Worker<DiscoverJob>(
  QUEUE_DISCOVER,
  async (job) => {
    const r = await rodarDescoberta(job.data.qual, job.data.limite);
    console.log(`[discover] ${job.data.qual}:`, r);
    return r;
  },
  { connection: makeRedis(), concurrency: 1 },
).on('failed', (job, err) => console.error(`[discover] ${job?.data.qual} falhou:`, err.message));

// Agenda: coleta completa a cada 6h por fonte, refresh de lote quente a cada 2 min.
for (const c of connectors) {
  await collectQueue.add(
    `collect:${c.def.id}`,
    // MEDIDO em 15/09: com limite 600 o Superbid gravava 6.125 lotes enquanto a
    // API entregava 10.463 abertos — a fonte não era o gargalo, o limite era.
    // Fontes de API devolvem catálogo grande numa requisição; as de HTML são
    // caras por lote e continuam com teto menor.
    { sourceId: c.def.id, limit: c.def.method === 'api' ? 15000 : 1200 },
    { repeat: { pattern: '17 */6 * * *' }, jobId: `repeat-collect-${c.def.id}`, removeOnComplete: 20, removeOnFail: 20 },
  );
}
await refreshQueue.add(
  'refresh:hot',
  { reason: 'lotes encerrando' },
  { repeat: { pattern: '*/2 * * * *' }, jobId: 'repeat-refresh', removeOnComplete: 20, removeOnFail: 20 },
);

// Descoberta é semanal porque cadastro de junta comercial muda devagar, e a
// sonda vai em fatia diária: são 1.023 sites a 1 req/s por host, uns 17 min de
// uma vez só. A fatia de 150 cobre o catálogo inteiro em uma semana.
await discoverQueue.add(
  'discover:fenaju',
  { qual: 'fenaju' },
  { repeat: { pattern: '23 4 * * 1' }, jobId: 'repeat-discover-fenaju', removeOnComplete: 10, removeOnFail: 10 },
);
await discoverQueue.add(
  'discover:sonda',
  { qual: 'sonda', limite: 150 },
  { repeat: { pattern: '41 5 * * *' }, jobId: 'repeat-discover-sonda', removeOnComplete: 10, removeOnFail: 10 },
);

console.log('worker de coleta no ar (filas: collect, refresh, discover)');
