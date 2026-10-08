import { pathToFileURL } from 'node:url';
import { Worker, type Job, type Processor, type Queue } from 'bullmq';
import { getConnector, connectors } from '../connectors/index.js';
import { upsertLots, startRun, finishRun, ensureSources, registrarLeituraAoVivo } from '../core/repo.js';
import { LEITORES, intervaloMs, lotesQuentes } from '../core/aoVivo.js';
import { processarAposColeta } from '../core/pos-coleta.js';
import { query } from '../core/db.js';
import { rodarDescoberta } from '../core/descoberta.js';
import { encerrarLotes, verificarCandidatos } from '../core/encerramento.js';
import { consultaFreio } from '../core/freio.js';
import { collectionJobContext, observerForCollection } from '../core/collection-observer.js';
import { CollectionCancellationError } from '../core/collection-cancellation.js';
import {
  executeCollection,
  type CollectionExecutionDependencies,
  type CollectionExecutionOptions,
  type CollectionExecutionResult,
  type CollectionMetadata,
} from '../core/collection-execution.js';
import {
  QUEUE_COLLECT, QUEUE_REFRESH, QUEUE_DISCOVER, CHANNEL_UPDATES, makeRedis,
  collectQueue, refreshQueue, discoverQueue, type CollectJob, type RefreshJob, type DiscoverJob,
} from './queues.js';

const publisher = makeRedis();

/**
 * Deps reais do worker para o executor compartilhado (`executeCollection`) —
 * mesmo mapa que a CLI monta em `scripts/collect.ts`. Os testes offline
 * sobrescrevem só as partes de I/O; a montagem e os tipos são os de produção.
 */
export function createWorkerDeps(overrides: Partial<CollectionExecutionDependencies> = {}): CollectionExecutionDependencies {
  return {
    lookupConnector: getConnector,
    startRun,
    finishRun,
    upsertLots,
    observerForCollection,
    processarAposColeta,
    publishNotification: (payload) => publisher.publish(CHANNEL_UPDATES, JSON.stringify(payload)),
    logError: (mensagem, erro) => console.error(mensagem, erro),
    ...overrides,
  };
}

export interface WorkerCollectOptions {
  sourceId: string;
  limit: number;
  metadata?: CollectionMetadata;
  /** Shutdown do worker ou perda de lock: o `kind` do motivo vira o do erro. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Job BullMQ em processamento; a posse do lock (`token`) autoriza o upsert. */
  queueJob?: Pick<Job<CollectJob>, 'id' | 'name' | 'token'>;
  publish?: CollectionExecutionOptions['publish'];
  authorizePersistence?: CollectionExecutionOptions['authorizePersistence'];
}

/**
 * Coleta do worker sobre o executor compartilhado. Diferenças para a CLI:
 * run com `job: 'collect'` (o nome que o freio e a tela de cobertura leem),
 * `checkEmptyHttpFailure` sempre ligado e eventos `bids`/`collect` no canal
 * `lot-updates`. Sem job BullMQ (uso manual) a persistência segue normal; com
 * job mas sem token de lock, o upsert é barrado antes de escrever — BullMQ só
 * entrega `job.token` a quem processa o job, então na prática esse portão só
 * fecha em posse perdida. Não existe `job.isOwnedBy`; o token é o sinal.
 */
export async function executeWorkerCollect(
  options: WorkerCollectOptions,
  deps: CollectionExecutionDependencies = createWorkerDeps(),
): Promise<CollectionExecutionResult> {
  const { queueJob, publish, authorizePersistence, ...resto } = options;
  const autorizar = async () => {
    if (queueJob && !queueJob.token) {
      throw new CollectionCancellationError('lock_lost', `job ${queueJob.id ?? queueJob.name} sem token de lock`);
    }
    await authorizePersistence?.();
  };
  return executeCollection(
    {
      ...resto,
      job: 'collect',
      checkEmptyHttpFailure: true,
      ...(queueJob || authorizePersistence ? { authorizePersistence: autorizar } : {}),
      publish: publish ?? ((evento) => publisher.publish(CHANNEL_UPDATES, JSON.stringify(evento))),
    },
    deps,
  );
}

/** Coletas em andamento, por job: shutdown e perda de lock derrubam só o que está rodando. */
const emAndamento = new Map<string, AbortController>();

function cancelarEmAndamento(kind: 'shutdown' | 'lock_lost', jobIds?: string[], message?: string) {
  const alvos = jobIds ? jobIds.filter((id) => emAndamento.has(id)) : [...emAndamento.keys()];
  for (const id of alvos) emAndamento.get(id)!.abort(new CollectionCancellationError(kind, message));
}

/** Freio ANTES da rede: sem isto, cada chamador teria que consultar por
 * conta própria e um deles esqueceria (ver [[freio]]). */
async function runCollect(
  sourceId: string,
  limit: number,
  metadata: CollectionMetadata = { origin: 'unknown' },
  exec: Pick<WorkerCollectOptions, 'signal' | 'timeoutMs' | 'queueJob'> = {},
) {
  const freio = await consultaFreio(sourceId);
  if (!freio.permite) {
    console.log(`[coletar] ${sourceId} freado (${freio.seguidas} falhas seguidas) — próxima sonda às ${freio.proxima?.toISOString()}`);
    return { fetched: 0, upserted: 0, skipped: 0, freado: true };
  }
  // startRun, validação da fonte, HTTP vazio, upsert e finishRun vivem no
  // executor compartilhado (mesmo caminho da CLI, ver [[collection-execution]]).
  const r = await executeWorkerCollect({ sourceId, limit, metadata, ...exec });
  return { fetched: r.result.fetched, upserted: r.upserted, skipped: r.result.skipped };
}

/**
 * Processador da fila collect: UMA tentativa por job.
 *
 * BullMQ padrão é `attempts=1` e o agendador não pede retry, então não há
 * repetição às cegas: toda falha já gravou `finishRun(ok=false)` no executor e
 * volta como `failed` para o BullMQ. Repetir de dentro daqui criaria um segundo
 * run sem ninguém olhar o motivo (e `maxStartedAttempts` não existe em BullMQ).
 */
const processarCollect: Processor<CollectJob> = async (job, _token, sinal) => {
  const id = job.id ?? job.name;
  const controller = new AbortController();
  emAndamento.set(id, controller);
  // Sinal nativo do BullMQ: abortado quando o próprio worker fecha.
  const fechando = () => controller.abort(new CollectionCancellationError('shutdown', 'worker fechando'));
  if (sinal) {
    if (sinal.aborted) fechando();
    else sinal.addEventListener('abort', fechando, { once: true });
  }
  try {
    return await runCollect(job.data.sourceId, job.data.limit, collectionJobContext(job, 'cron'), {
      signal: controller.signal,
      queueJob: job,
    });
  } catch (err: any) {
    console.error(`[collect] ${job.data.sourceId} falhou (sem retry automático): ${err?.message ?? err}`);
    throw err;
  } finally {
    sinal?.removeEventListener('abort', fechando);
    emAndamento.delete(id);
  }
};

/** Quanto tempo antes e depois da abertura um leilão de pregão fica "quente". */
const ANTES_DA_ABERTURA_H = 2;
const DEPOIS_DA_ABERTURA_H = 3;
/** Piso entre duas recoletas da MESMA fonte de pregão. */
const DESCANSO_PREGAO_MIN = 5;

/**
 * Refresh quente: recoleta as fontes cujos lotes estão em disputa agora.
 *
 * A versão anterior só olhava `timer_por_lote` com `auction_end_utc` na próxima
 * hora, e o comentário afirmava que "fonte com timer por lote é a única em que
 * isso muda alguma coisa". MEDIDO em 17/09 e FALSO: 430 lotes da Copart, 90 do
 * soleon, 77 do kuss, 35 do suporte-leilões e 21 do leilão PRO já tiveram o
 * lance alterado. Todos são `pregao_em_horario` ou `sequencial`, e nenhum tem
 * `auction_end_utc` — eram estruturalmente invisíveis ao refresh e só mudavam
 * na coleta de 6 em 6 horas. A média de observações por lote denuncia: 1,61 no
 * pregão contra 2,84 no timer.
 *
 * Para o pregão o que discrimina é a ABERTURA, não o fim, porque a fonte não
 * publica fim por lote.
 */
/**
 * Fontes com agenda fixa (ver `agendar(collectQueue, ...)` mais abaixo) ficam
 * de fora do refresh quente. Sem isto o ramo `timer_por_lote` — sem nenhum
 * descanso — bate a cada 2 min em QUALQUER fonte com lote fechando na
 * próxima hora, e é o que produziu as 1.218 coletas/7d do superbid.
 */
const FORA_DO_REFRESH = new Set(['superbid']);

/** Minutos entre recoletas do catálogo de uma fonte de timer, pelo lote que fecha primeiro. */
function descansoRecoletaMin(fim: Date): number {
  const falta = fim.getTime() - Date.now();
  if (falta > 15 * 60_000) return 10;
  if (falta > 5 * 60_000) return 4;
  return 2;
}

/* ------------------------------------------------------------------ */
/* Ao vivo                                                             */
/* ------------------------------------------------------------------ */

const AO_VIVO = process.env.AO_VIVO !== '0';
const proximaLeitura = new Map<number, number>();
/** Lote quente que o canal não conseguiu ler → fonte dele. Essas fontes voltam para o refresh. */
const semCanalLotes = new Map<number, string>();
const semCanal = { has: (fonte: string) => [...semCanalLotes.values()].includes(fonte) };
let lendoAoVivo = false;

async function cicloAoVivo() {
  if (lendoAoVivo) return;
  lendoAoVivo = true;
  try {
    const agora = Date.now();
    const lotes = await lotesQuentes(Object.keys(LEITORES));
    const vivos = new Set(lotes.map((l) => l.id));
    for (const id of proximaLeitura.keys()) if (!vivos.has(id)) proximaLeitura.delete(id);
    for (const id of semCanalLotes.keys()) if (!vivos.has(id)) semCanalLotes.delete(id);

    const mudancas = [];
    let lidos = 0;
    for (const lote of lotes) {
      const intervalo = intervaloMs(lote.fim, agora);
      if (intervalo == null || (proximaLeitura.get(lote.id) ?? 0) > agora) continue;
      // Jitter de até 20%: leitura sempre no mesmo segundo é assinatura de robô.
      proximaLeitura.set(lote.id, agora + intervalo * (1 + Math.random() * 0.2));
      let leitura = null;
      try {
        leitura = await LEITORES[lote.sourceId](lote);
      } catch (e: any) {
        console.error(`[aovivo] ${lote.sourceId} ${lote.externalId}:`, e.message);
      }
      lidos++;
      if (!leitura) {
        semCanalLotes.set(lote.id, lote.sourceId);
        continue;
      }
      semCanalLotes.delete(lote.id);
      const m = await registrarLeituraAoVivo(lote.id, leitura.lance, leitura.fim);
      if (m) mudancas.push(m);
      await new Promise((r) => setTimeout(r, 150));
    }
    if (mudancas.length) await publisher.publish(CHANNEL_UPDATES, JSON.stringify({ type: 'bids', changes: mudancas }));
    if (lidos) console.log(`[aovivo] ${lidos} lidos · ${mudancas.length} lances novos · ${semCanalLotes.size} sem canal`);
  } catch (e: any) {
    console.error('[aovivo] falhou:', e.message);
  } finally {
    lendoAoVivo = false;
  }
}

async function runRefresh(metadata: CollectionMetadata = { origin: 'refresh' }) {
  const quentes = new Map<string, number>();

  // Timer por lote: limite pequeno basta, porque o conector dessas fontes
  // entrega primeiro o que encerra antes. O descanso cresce com a distância do
  // fechamento: recoletar o catálogo a cada 2 min por um lote que fecha daqui a
  // 50 min era o que punha o vlance em 30 coletas por hora.
  for (const row of await query<{ source_id: string; fim: Date; ultima: Date | null }>(`
    SELECT l.source_id, min(l.auction_end_utc) AS fim,
           (SELECT max(r.started_at) FROM collection_runs r WHERE r.source_id = l.source_id) AS ultima
      FROM lots l
     WHERE l.closing_model = 'timer_por_lote'
       AND l.status IN ('aberto','agendado')
       AND l.auction_end_utc BETWEEN now() AND now() + interval '1 hour'
     GROUP BY l.source_id`)) {
    if (FORA_DO_REFRESH.has(row.source_id)) continue;
    // Fonte com canal ao vivo só recoleta pelo lote que o canal não alcançou.
    const aoVivo = AO_VIVO && row.source_id in LEITORES;
    if (aoVivo && !semCanal.has(row.source_id)) continue;
    const descansoMin = aoVivo ? 15 : descansoRecoletaMin(new Date(row.fim));
    if (row.ultima && Date.now() - new Date(row.ultima).getTime() < descansoMin * 60_000) continue;
    quentes.set(row.source_id, 120);
  }

  /**
   * Pregão: precisa do limite CHEIO, não de 120.
   *
   * O conector da Copart pagina `query:'*'` sem ordenação nenhuma, então os
   * 120 primeiros não têm relação com qual leilão abre agora — recoletar com
   * limite pequeno gastaria requisição sem alcançar o lote em disputa.
   *
   * O descanso evita que uma coleta cheia (73s medidos na Copart) rode de volta
   * em volta, já que este ciclo dispara a cada 2 minutos.
   */
  for (const row of await query<{ source_id: string }>(`
    SELECT DISTINCT l.source_id FROM lots l
     WHERE l.closing_model <> 'timer_por_lote'
       AND l.status IN ('aberto','agendado')
       AND l.auction_start_utc BETWEEN now() - interval '${DEPOIS_DA_ABERTURA_H} hours'
                                   AND now() + interval '${ANTES_DA_ABERTURA_H} hours'
       AND NOT EXISTS (
         SELECT 1 FROM collection_runs r
          WHERE r.source_id = l.source_id
            AND r.started_at > now() - interval '${DESCANSO_PREGAO_MIN} minutes')`)) {
    const c = connectors.find((x) => x.def.id === row.source_id);
    if (c) quentes.set(row.source_id, c.def.method === 'api' ? 15000 : 1200);
  }

  const hot = [...quentes];
  if (!hot.length) return { hot: 0 };
  for (const [sourceId, limite] of hot) {
    await runCollect(sourceId, limite, { ...metadata, origin: 'refresh' });
  }
  console.log(`[refresh] ${hot.map(([f, l]) => `${f}(${l})`).join(' ')}`);
  return { hot: hot.length };
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

/** Reagenda as três filas (idempotente). Chamado só por `createWorkerHub().start()`. */
async function agendarTudo() {
  // Agenda: coleta completa 3x/dia por fonte, refresh de lote quente a cada 2 min.
  // MEDIDO em 22/09 (auction_start_utc, BRT): picos às 9h-10h, 14h e 17h-18h. Sem
  // o 3º horário, a lacuna 13h→07h (18h) carregava 49% do catálogo, incluindo 701
  // lotes `pregao_em_horario` — fecham na própria abertura, e um publicado depois
  // das 13h só apareceria às 07h já encerrado.
  await agendar(collectQueue, connectors.map((c) => ({
    id: `collect-${c.def.id}`,
    nome: `collect:${c.def.id}`,
    pattern: '0 7,13,18 * * *',
    // MEDIDO em 15/09: com limite 600 o Superbid gravava 6.125 lotes enquanto a
    // API entregava 10.463 abertos — a fonte não era o gargalo, o limite era.
    // Fontes de API devolvem catálogo grande numa requisição; as de HTML são
    // caras por lote e continuam com teto menor.
    data: { sourceId: c.def.id, limit: c.def.method === 'api' ? 15000 : 1200 },
    manter: 20,
  })));

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
}

export interface WorkerHubDeps {
  /** Processador da fila collect (default: freio + `executeWorkerCollect`). */
  collect?: Processor<CollectJob>;
  refresh?: Processor<RefreshJob>;
  discover?: Processor<DiscoverJob>;
}

export interface WorkerHub {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Worker completo (filas, agenda e ciclos internos) sem efeito no import: só
 * `start()` toca Redis e banco. `stop()` cancela as coletas em andamento com
 * kind `shutdown`, derruba os timers e fecha os workers — o job em voo grava
 * `finishRun(ok=false)` e sai.
 *
 * As conexões continuam vindo de `makeRedis()` (o singleton de `queues.js`);
 * nada aqui migra para construtores próprios porque as filas singletons já
 * consomem a mesma fábrica.
 */
export function createWorkerHub(deps: WorkerHubDeps = {}): WorkerHub {
  const workers: Worker[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let ligado = false;

  const periodico = (fn: () => void, ms: number) => {
    const t = setInterval(fn, ms);
    t.unref();
    timers.push(t);
  };

  const aoPerderLock = (jobIds: string[]) => {
    console.error(`[collect] lock não renovado em ${jobIds.join(' ')} — cancelando a coleta antes do próximo passo`);
    cancelarEmAndamento('lock_lost', jobIds, 'lockRenewalFailed');
  };

  return {
    async start() {
      if (ligado) return;
      ligado = true;
      if (AO_VIVO) periodico(cicloAoVivo, 15_000);
      periodico(cicloDeEncerramento, 60_000);
      periodico(cicloDeVerificacao, Number(process.env.VERIFICAR_INTERVALO_MS ?? 300_000));
      // Roda na subida também: reiniciar o worker não deve deixar lote vencido
      // esperando o primeiro minuto.
      void cicloDeVerificacao();
      void cicloDeEncerramento();

      // ensureSources primeiro: banco fora do ar aborta aqui, antes de qualquer
      // comando em Redis (limparAgendamentosOrfaos varre a fila).
      await ensureSources();
      await limparAgendamentosOrfaos();

      workers.push(
        new Worker<CollectJob>(QUEUE_COLLECT, deps.collect ?? processarCollect, { connection: makeRedis(), concurrency: 2 })
          .on('failed', (job, err) => console.error(`[collect] ${job?.data.sourceId} falhou:`, err.message))
          .on('error', (err) => console.error('[collect] worker:', err.message))
          .on('lockRenewalFailed', aoPerderLock),
        new Worker<RefreshJob>(QUEUE_REFRESH, deps.refresh ?? ((job) => runRefresh(collectionJobContext(job, 'refresh'))), {
          connection: makeRedis(),
          concurrency: 1,
        })
          .on('failed', (_job, err) => console.error('[refresh] falhou:', err.message))
          .on('error', (err) => console.error('[refresh] worker:', err.message))
          .on('lockRenewalFailed', aoPerderLock),
        new Worker<DiscoverJob>(
          QUEUE_DISCOVER,
          deps.discover ?? (async (job) => {
            const r = await rodarDescoberta(job.data.qual, job.data.limite);
            console.log(`[discover] ${job.data.qual}:`, r);
            return r;
          }),
          { connection: makeRedis(), concurrency: 1 },
        )
          .on('failed', (job, err) => console.error(`[discover] ${job?.data.qual} falhou:`, err.message))
          .on('error', (err) => console.error('[discover] worker:', err.message)),
      );

      await agendarTudo();
      console.log('worker de coleta no ar (filas: collect, refresh, discover)');
    },

    async stop() {
      if (!ligado) return;
      ligado = false;
      cancelarEmAndamento('shutdown', undefined, 'worker encerrando');
      for (const t of timers.splice(0)) clearInterval(t);
      await Promise.all(workers.splice(0).map((w) => w.close()));
    },
  };
}

/**
 * Execução como processo (`npm run worker`): todo o comportamento — agenda,
 * workers e ciclos — só sobe quando este arquivo é o argv[1]. Importar o módulo
 * (teste offline) não toca Redis nem banco.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hub = createWorkerHub();
  let encerrando = false;
  const encerrar = (codigo: number) => {
    // Segundo sinal não espera: igual à CLI, quem aperta duas vezes quer sair.
    if (encerrando) process.exit(codigo);
    encerrando = true;
    void hub.stop().finally(() => process.exit(codigo));
  };
  process.once('SIGINT', () => encerrar(130));
  process.once('SIGTERM', () => encerrar(143));
  await hub.start();
}
