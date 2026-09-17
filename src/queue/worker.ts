
import { Worker, type Queue } from 'bullmq';
import { getConnector, connectors } from '../connectors/index.js';
import { upsertLots, startRun, finishRun, ensureSources } from '../core/repo.js';
import { processarAposColeta } from '../core/pos-coleta.js';
import { query } from '../core/db.js';
import { rodarDescoberta } from '../core/descoberta.js';
import { encerrarLotes, verificarCandidatos } from '../core/encerramento.js';
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
    const total = r.porPrazo + r.porAusencia;
    if (total) {
      console.log(`[encerrar] prazo: ${r.porPrazo} · ausente na fonte: ${r.porAusencia}`);
      // Mesmo canal do lance e da coleta: a tela avisa sem recarregar. O ciclo
      // roda a cada minuto e quase sempre fecha zero — publicar o zero encheria
      // a tela de aviso vazio.
      await publisher.publish(
        CHANNEL_UPDATES,
        JSON.stringify({ type: 'encerrados', total, porPrazo: r.porPrazo, porAusencia: r.porAusencia }),
      );
    }
  } catch (e: any) {
    console.error('[encerrar] falhou:', e.message);
  } finally {
    travado = false;
  }
}
setInterval(cicloDeEncerramento, 60_000).unref();

/**
 * Verificação na origem, em ciclo próprio e mais lento.
 *
 * Separada do encerramento por prazo porque a natureza é outra: aquele é uma
 * consulta local de milissegundos, este faz dezenas de requisições a sites de
 * terceiros e leva minutos. Rodar os dois no mesmo intervalo faria a varredura
 * de rede atrasar o fechamento por relógio, que não depende de rede nenhuma.
 */
let verificando = false;
async function cicloDeVerificacao() {
  if (verificando) return;
  verificando = true;
  try {
    const r = await verificarCandidatos();
    if (r.verificados) {
      console.log(
        `[verificar] ${r.verificados} conferidos na origem: ${r.encerrados} encerrados, ` +
          `${r.vivos} vivos, ${r.indeterminados} sem resposta`,
      );
      if (r.encerrados) {
        await publisher.publish(
          CHANNEL_UPDATES,
          JSON.stringify({ type: 'encerrados', total: r.encerrados, origem: 'verificacao' }),
        );
      }
    }
  } catch (e: any) {
    console.error('[verificar] falhou:', e.message);
  } finally {
    verificando = false;
  }
}
setInterval(cicloDeVerificacao, Number(process.env.VERIFICAR_INTERVALO_MS ?? 300_000)).unref();
void cicloDeVerificacao();
// Roda na subida também: reiniciar o worker não deve deixar lote vencido
// esperando o primeiro minuto.
void cicloDeEncerramento();

/**
 * Job repetido que não tem mais conector fica órfão no Redis e falha a cada
 * ciclo com "fonte desconhecida". Aconteceu com `collect:serrano`, que virou
 * `vlance` quando descobrimos que era um tenant da mesma plataforma: o agendado
 * sobreviveu à renomeação porque vive no Redis, não no código.
 */
async function limparAgendamentosOrfaos() {
  for (const r of await collectQueue.getRepeatableJobs()) {
    const id = r.name.replace(/^collect:/, '');
    if (!getConnector(id)) {
      await collectQueue.removeRepeatableByKey(r.key);
      console.log(`[agenda] removido job órfão ${r.name} (sem conector)`);
    }
  }
}
await limparAgendamentosOrfaos();

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

/**
 * Registra a agenda de uma fila, substituindo o que já existe no Redis.
 *
 * `queue.add()` com `repeat` NÃO atualiza um agendador já gravado: o payload
 * fica congelado no Redis e o código novo vira decoração. Foi o que aconteceu
 * com o teto de coleta — a medição de 15/09 subiu o limite para 15000 no
 * código, e superbid, copart, leilo, caixa, freitas, kuss, leilaopro e soleon
 * seguiram rodando com os 600 antigos, porque o agendador deles já existia.
 * Só as fontes criadas DEPOIS pegaram o valor novo.
 *
 * O dano não parou na coleta curta: `verificarCandidatos` só aceita varredura
 * com `limite >= 1000`, então nenhuma coleta agendada contava como varredura e
 * a verificação na origem nunca teve candidato — a rede de segurança do
 * encerramento estava desligada sem sintoma.
 *
 * `upsertJobScheduler` atualiza, mas a chave dele é o id que passamos, e a do
 * `add({repeat, jobId})` é um HASH das opções. Só trocar de API criaria um
 * segundo agendador ao lado do velho e a coleta rodaria duas vezes. Por isso a
 * remoção dos ids que não são nossos vem antes — e é idempotente: no primeiro
 * boot apaga os legados, nos seguintes não acha nada para apagar.
 */
async function agendar(
  fila: Queue,
  itens: Array<{ id: string; nome: string; pattern: string; data: unknown; manter: number }>,
) {
  const meus = new Set(itens.map((i) => i.id));
  for (const s of await fila.getJobSchedulers(0, 200, true)) {
    const chave = (s as any).key ?? (s as any).id;
    if (chave && !meus.has(chave)) {
      await fila.removeJobScheduler(chave);
      console.log(`[agenda] agendador legado removido de ${fila.name}: ${chave}`);
    }
  }
  for (const i of itens) {
    await fila.upsertJobScheduler(
      i.id,
      { pattern: i.pattern },
      { name: i.nome, data: i.data, opts: { removeOnComplete: i.manter, removeOnFail: i.manter } },
    );
  }
}

// Agenda: coleta completa a cada 6h por fonte, refresh de lote quente a cada 2 min.
await agendar(
  collectQueue,
  connectors.map((c) => ({
    id: `collect-${c.def.id}`,
    nome: `collect:${c.def.id}`,
    pattern: '17 */6 * * *',
    // MEDIDO em 15/09: com limite 600 o Superbid gravava 6.125 lotes enquanto a
    // API entregava 10.463 abertos — a fonte não era o gargalo, o limite era.
    // Fontes de API devolvem catálogo grande numa requisição; as de HTML são
    // caras por lote e continuam com teto menor.
    data: { sourceId: c.def.id, limit: c.def.method === 'api' ? 15000 : 1200 },
    manter: 20,
  })),
);

await agendar(refreshQueue, [
  { id: 'refresh-hot', nome: 'refresh:hot', pattern: '*/2 * * * *', data: { reason: 'lotes encerrando' }, manter: 20 },
]);

// Descoberta é semanal porque cadastro de junta comercial muda devagar, e a
// sonda vai em fatia diária: são 1.023 sites a 1 req/s por host, uns 17 min de
// uma vez só. A fatia de 150 cobre o catálogo inteiro em uma semana.
await agendar(discoverQueue, [
  { id: 'discover-fenaju', nome: 'discover:fenaju', pattern: '23 4 * * 1', data: { qual: 'fenaju' }, manter: 10 },
  { id: 'discover-sonda', nome: 'discover:sonda', pattern: '41 5 * * *', data: { qual: 'sonda', limite: 150 }, manter: 10 },
]);

console.log('worker de coleta no ar (filas: collect, refresh, discover)');
