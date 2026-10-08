import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createWorkerDeps, executeWorkerCollect, type WorkerCollectOptions } from '../src/queue/worker.js';
import { collectQueue, refreshQueue, discoverQueue } from '../src/queue/queues.js';
import { CollectionCancellationError } from '../src/core/collection-cancellation.js';
import type {
  CollectionExecutionDependencies,
  CollectionRunData,
} from '../src/core/collection-execution.js';
import type { Connector, CollectResult } from '../src/connectors/types.js';
import type { UpsertOutcome } from '../src/core/repo.js';

/**
 * Teste OFFLINE do caminho de coleta do worker: exercita os exports novos de
 * `src/queue/worker.ts` (`createWorkerDeps` + `executeWorkerCollect`) com deps
 * e conectores falsos. Não cria `Worker` do BullMQ (exigiria Redis), não starta
 * o hub, não toca banco e não executa comando externo — rodar com:
 *
 *   node --import tsx --test scripts/teste-worker-cancellation.ts
 *
 * Importar `worker.ts` importa `queues.js`, cujas filas BullMQ singletons abrem
 * conexões TCP no import; o `after()` abaixo fecha as três para o processo
 * terminar sem `--test-force-exit`.
 */

after(async () => {
  await Promise.allSettled(
    [collectQueue, refreshQueue, discoverQueue].map(async (queue) => {
      // `queues.ts` cria o ioredis antes de passar como `connection`, então o
      // BullMQ o trata como compartilhado e `close()` não derruba o socket:
      // quem fecha é o cliente em si.
      const client = await queue.client;
      await queue.close();
      await client.quit();
    }),
  );
});

function esperar() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const lote = { externalId: 'L1', title: 'Lote 1' } as unknown as CollectResult['lots'][number];

function fonte(collect: () => Promise<CollectResult>): Connector {
  return { def: { id: 'fake' } as Connector['def'], collect } as Connector;
}

interface Cenario {
  deps: CollectionExecutionDependencies;
  startChamadas: Array<{ sourceId: string; job: string; limit: number }>;
  finishChamadas: CollectionRunData[];
  upsertChamadas: number;
  posColetaChamadas: number;
  alertas: unknown[];
  logErros: Array<[string, unknown]>;
}

/** Monta as deps reais do worker (createWorkerDeps) trocando só o I/O. */
function montarDeps(opcoes: {
  connector?: Connector;
  upsert?: (lots: CollectResult['lots']) => Promise<UpsertOutcome>;
} = {}): Cenario {
  const cenario: Cenario = {
    startChamadas: [],
    finishChamadas: [],
    upsertChamadas: 0,
    posColetaChamadas: 0,
    alertas: [],
    logErros: [],
    deps: createWorkerDeps({
      lookupConnector: () => opcoes.connector ?? fonte(async () => ({ lots: [], fetched: 0, skipped: 0 })),
      startRun: async (sourceId, job, limit) => {
        cenario.startChamadas.push({ sourceId, job, limit });
        return 7;
      },
      finishRun: async (_runId, data) => { cenario.finishChamadas.push(data); },
      upsertLots: async (lots) => {
        cenario.upsertChamadas++;
        if (opcoes.upsert) return opcoes.upsert(lots);
        return { upserted: lots.length, novos: [], bidChanges: [] };
      },
      observerForCollection: () => undefined,
      processarAposColeta: async () => {
        cenario.posColetaChamadas++;
        return { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 };
      },
      publishNotification: async (payload) => { cenario.alertas.push(payload); },
      logError: (mensagem, erro) => { cenario.logErros.push([mensagem, erro]); },
    }),
  };
  return cenario;
}

const opcoesBase = (extra: Partial<WorkerCollectOptions> = {}): WorkerCollectOptions => ({
  sourceId: 'fake',
  limit: 10,
  metadata: { origin: 'cron' },
  ...extra,
});

const gravador = () => {
  const eventos: string[] = [];
  return { eventos, publish: async (evento: { type: string }) => { eventos.push(evento.type); } };
};

test('defaults do worker: run abre com job=collect e HTTP vazio fora de 2xx vira falha', async () => {
  const { eventos, publish } = gravador();
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [], fetched: 0, skipped: 0, httpStatus: 403 })),
  });
  await assert.rejects(
    executeWorkerCollect(opcoesBase({ publish }), cenario.deps),
    /HTTP 403/,
  );
  assert.deepEqual(cenario.startChamadas, [{ sourceId: 'fake', job: 'collect', limit: 10 }]);
  assert.equal(cenario.finishChamadas.length, 1, 'finishRun uma vez');
  assert.equal(cenario.finishChamadas[0].ok, false);
  assert.equal(cenario.finishChamadas[0].httpStatus, 403);
  assert.equal(cenario.upsertChamadas, 0, 'HTTP bloqueado não persiste');
  assert.deepEqual(eventos, [], 'falha não publica evento');
});

test('job que nunca completa: timeout encerra com finish ok=false e sem upsert', async () => {
  const { eventos, publish } = gravador();
  const cenario = montarDeps({
    connector: fonte(() => new Promise<CollectResult>(() => { /* nunca completa */ })),
  });
  await assert.rejects(
    executeWorkerCollect(
      opcoesBase({ timeoutMs: 50, queueJob: { id: '42', name: 'collect:fake', token: 'tok' }, publish }),
      cenario.deps,
    ),
    (err: unknown) => err instanceof CollectionCancellationError && err.kind === 'deadline',
  );
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, false, 'prazo nunca vira ok=true');
  assert.equal(cenario.upsertChamadas, 0);
  assert.deepEqual(eventos, []);
});

test('shutdown durante a aquisição do catálogo: finish ok=false, sem upsert e sem evento', async () => {
  const { eventos, publish } = gravador();
  const comecou = esperar();
  const cenario = montarDeps({
    connector: fonte(async () => {
      comecou.resolve();
      return new Promise<CollectResult>(() => { /* só termina com abort */ });
    }),
  });
  const controller = new AbortController();
  const execucao = executeWorkerCollect(opcoesBase({ signal: controller.signal, publish }), cenario.deps);
  await comecou.promise;
  controller.abort(new CollectionCancellationError('shutdown'));
  await assert.rejects(
    execucao,
    (err: unknown) => err instanceof CollectionCancellationError && err.kind === 'shutdown',
  );
  assert.equal(cenario.upsertChamadas, 0, 'nada persistido depois do shutdown');
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, false);
  assert.deepEqual(eventos, []);
});

test('lock perdido (lockRenewalFailed) aborta coleta nova: conector nem é chamado', async () => {
  const { eventos, publish } = gravador();
  let chamadas = 0;
  const cenario = montarDeps({
    connector: fonte(async () => {
      chamadas++;
      return { lots: [lote], fetched: 1, skipped: 0 };
    }),
  });
  const controller = new AbortController();
  controller.abort(new CollectionCancellationError('lock_lost'));
  await assert.rejects(
    executeWorkerCollect(opcoesBase({ signal: controller.signal, publish }), cenario.deps),
    (err: unknown) => err instanceof CollectionCancellationError && err.kind === 'lock_lost',
  );
  assert.equal(chamadas, 0, 'catálogo novo não começa sem posse');
  assert.equal(cenario.upsertChamadas, 0);
  assert.equal(cenario.finishChamadas[0]?.ok, false);
  assert.deepEqual(eventos, []);
});

test('job BullMQ sem token de lock: persistência barrada antes do upsert', async () => {
  const { eventos, publish } = gravador();
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [lote], fetched: 1, skipped: 0 })),
  });
  await assert.rejects(
    executeWorkerCollect(
      opcoesBase({ queueJob: { id: '7', name: 'collect:fake', token: undefined }, publish }),
      cenario.deps,
    ),
    (err: unknown) => err instanceof CollectionCancellationError && err.kind === 'lock_lost',
  );
  assert.equal(cenario.upsertChamadas, 0, 'sem token não grava');
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, false);
  assert.deepEqual(eventos, []);
});

test('job com token: persiste, fecha finish ok=true e publica bids/collect', async () => {
  const { eventos, publish } = gravador();
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [lote], fetched: 1, skipped: 0 })),
    upsert: async (lots) => ({
      upserted: lots.length,
      novos: [1],
      bidChanges: [{ lotId: 1, sourceId: 'fake', externalId: 'L1', title: 'Lote 1', oldBid: 10, newBid: 20 }],
    }),
  });
  const r = await executeWorkerCollect(
    opcoesBase({ queueJob: { id: '8', name: 'collect:fake', token: 'tok' }, publish }),
    cenario.deps,
  );
  assert.equal(r.upserted, 1);
  assert.equal(cenario.posColetaChamadas, 1, 'pós-coleta roda com os novos');
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, true);
  assert.deepEqual(eventos, ['bids', 'collect'], 'ordem dos eventos do worker');
});

test('shutdown durante a persistência: upsert protegido termina ok e o evento sai', async () => {
  const { eventos, publish } = gravador();
  const upsertComecou = esperar();
  const liberarUpsert = esperar();
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [lote], fetched: 1, skipped: 0 })),
    upsert: async (lots) => {
      upsertComecou.resolve();
      await liberarUpsert.promise;
      return { upserted: lots.length, novos: [], bidChanges: [] };
    },
  });
  const controller = new AbortController();
  const execucao = executeWorkerCollect(opcoesBase({ signal: controller.signal, publish }), cenario.deps);
  await upsertComecou.promise;
  controller.abort(new CollectionCancellationError('shutdown'));
  liberarUpsert.resolve();
  const r = await execucao;
  assert.equal(r.upserted, 1, 'resultado do upsert aproveitado');
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, true, 'persistência protegida conclui ok');
  assert.deepEqual(eventos, ['collect'], 'evento publicado mesmo com cancelamento tardio');
});
