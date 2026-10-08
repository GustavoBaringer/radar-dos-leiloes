import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeCollection,
  type CollectionExecutionDependencies,
  type CollectionExecutionOptions,
  type CollectionRunData,
} from '../src/core/collection-execution.js';
import { CollectionCancellationError } from '../src/core/collection-cancellation.js';
import type { Connector, CollectResult } from '../src/connectors/types.js';
import type { UpsertOutcome } from '../src/core/repo.js';

function esperar() {
  let resolve!: () => void;
  let rejeitar!: (e: unknown) => void;
  const promise = new Promise<void>((r, j) => { resolve = r; rejeitar = j; });
  return { promise, resolve, rejeitar };
}

const lote = { externalId: 'L1', title: 'Lote 1' } as unknown as CollectResult['lots'][number];

function fonte(collect: () => Promise<CollectResult>): Connector {
  return { def: { id: 'fake' } as Connector['def'], collect } as Connector;
}

interface Cenario {
  deps: CollectionExecutionDependencies;
  finishChamadas: CollectionRunData[];
  upsertChamadas: number;
  publishChamadas: unknown[];
  logErros: Array<[string, unknown]>;
}

function montarDeps(opcoes: {
  connector?: Connector;
  upsert?: (lots: CollectResult['lots']) => Promise<UpsertOutcome>;
} = {}): Cenario {
  const cenario: Cenario = {
    finishChamadas: [],
    upsertChamadas: 0,
    publishChamadas: [],
    logErros: [],
    deps: {
      lookupConnector: () => opcoes.connector ?? fonte(async () => ({ lots: [], fetched: 0, skipped: 0 })),
      startRun: async () => 7,
      finishRun: async (_runId, data) => { cenario.finishChamadas.push(data); },
      upsertLots: async (lots) => {
        cenario.upsertChamadas++;
        if (opcoes.upsert) return opcoes.upsert(lots);
        return { upserted: lots.length, novos: [], bidChanges: [] };
      },
      observerForCollection: () => undefined,
      processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
      publishNotification: async (payload) => { cenario.publishChamadas.push(payload); },
      logError: (mensagem, erro) => { cenario.logErros.push([mensagem, erro]); },
    },
  };
  return cenario;
}

const opcoesBase = (extra: Partial<CollectionExecutionOptions> = {}): CollectionExecutionOptions => ({
  sourceId: 'fake',
  limit: 10,
  metadata: { origin: 'manual' },
  ...extra,
});

test('fonte sem lotes grava finish ok=true com fetched=0', async () => {
  const cenario = montarDeps();
  const r = await executeCollection(opcoesBase(), cenario.deps);
  assert.equal(r.upserted, 0);
  assert.deepEqual(cenario.finishChamadas, [{ ok: true, fetched: 0, upserted: 0, skipped: 0, httpStatus: undefined }]);
});

test('prazo da coleta aborta conector que nunca completa e finishRun não marca ok=true', async () => {
  const cenario = montarDeps({
    connector: fonte(() => new Promise<CollectResult>(() => { /* nunca completa */ })),
  });
  await assert.rejects(
    executeCollection(opcoesBase({ timeoutMs: 50 }), cenario.deps),
    (err: unknown) => err instanceof CollectionCancellationError && err.kind === 'deadline',
  );
  assert.equal(cenario.finishChamadas.length, 1, 'finishRun chamado uma vez');
  assert.equal(cenario.finishChamadas[0].ok, false, 'prazo nunca vira ok=true');
  assert.equal(cenario.upsertChamadas, 0, 'nada persistido após o prazo');
});

test('cancelamento do chamador para antes do upsert e finishRun grava o erro', async () => {
  const cenario = montarDeps({
    connector: fonte(async () => {
      throw new CollectionCancellationError('shutdown');
    }),
  });
  const controller = new AbortController();
  controller.abort(new CollectionCancellationError('shutdown'));
  await assert.rejects(
    executeCollection(opcoesBase({ signal: controller.signal }), cenario.deps),
    (err: unknown) => err instanceof CollectionCancellationError && err.kind === 'shutdown',
  );
  assert.equal(cenario.upsertChamadas, 0, 'upsert não começa depois do cancelamento');
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, false);
  assert.match(String(cenario.finishChamadas[0].error), /cancelada|shutdown/);
});

test('shutdown durante a persistência protegida espera o upsert e termina ok', async () => {
  const upsertComecou = esperar();
  const liberarUpsert = esperar();
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [lote], fetched: 1, skipped: 0 })),
    upsert: async () => {
      upsertComecou.resolve();
      await liberarUpsert.promise;
      return { upserted: 1, novos: [1], bidChanges: [] };
    },
  });
  const controller = new AbortController();
  const execucao = executeCollection(opcoesBase({ signal: controller.signal }), cenario.deps);
  await upsertComecou.promise;
  controller.abort(new CollectionCancellationError('shutdown'));
  liberarUpsert.resolve();
  const r = await execucao;
  assert.equal(r.upserted, 1, 'resultado do upsert aproveitado');
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, true, 'persistência protegida conclui com ok=true');
});

test('após falha de persistência, nova execução reusa o publicador e grava finish ok', async () => {
  let falharUpsert = true;
  const publicado: Array<{ type: string }> = [];
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [lote], fetched: 1, skipped: 0 })),
    upsert: async () => {
      if (falharUpsert) throw new Error('banco em manutenção');
      return { upserted: 1, novos: [], bidChanges: [] };
    },
  });
  const publish = async (event: { type: string }) => { publicado.push({ type: event.type }); };
  await assert.rejects(executeCollection(opcoesBase({ publish }), cenario.deps), /banco em manutenção/);
  assert.equal(cenario.finishChamadas[0].ok, false, 'persistência falhou: finish ok=false');

  falharUpsert = false;
  const r = await executeCollection(opcoesBase({ publish }), cenario.deps);
  assert.equal(r.upserted, 1);
  assert.deepEqual(publicado.map((e) => e.type), ['collect'], 'evento publicado na execução seguinte');
  assert.equal(cenario.finishChamadas.length, 2);
  assert.equal(cenario.finishChamadas[1].ok, true, 'segunda execução grava finish ok');
});

test('falha ao publicar depois da persistência não reescreve o finish ok e continua os eventos', async () => {
  const publicado: Array<{ type: string }> = [];
  let falharNoBids = true;
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [lote], fetched: 1, skipped: 0 })),
    upsert: async () => ({
      upserted: 1,
      novos: [],
      bidChanges: [{ lotId: 1, sourceId: 'fake', externalId: 'L1', title: 'Lote 1', oldBid: 10, newBid: 20 }],
    }),
  });
  const r = await executeCollection(
    opcoesBase({
      publish: async (event) => {
        if (event.type === 'bids' && falharNoBids) {
          falharNoBids = false;
          throw new Error('redis indisponível');
        }
        publicado.push({ type: event.type });
      },
    }),
    cenario.deps,
  );
  assert.equal(r.publishErrors.length, 1, 'falha de publicação registrada');
  assert.match(r.publishErrors[0], /redis indisponível/);
  assert.deepEqual(publicado.map((e) => e.type), ['collect'], 'evento seguinte ainda publicado');
  assert.equal(cenario.finishChamadas.length, 1, 'finish gravado uma vez, sem regravar');
  assert.equal(cenario.finishChamadas[0].ok, true, 'finish já era ok antes da publicação falhar');
  assert.equal(cenario.logErros[0]?.[0], 'collection event publish failed');
});
