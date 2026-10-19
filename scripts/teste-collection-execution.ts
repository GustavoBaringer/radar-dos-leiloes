import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeCollection,
  type CollectionExecutionDependencies,
  type CollectionExecutionOptions,
  type CollectionRunData,
} from '../src/application/services/collection/collection-execution.js';
import { CollectionCancellationError, throwIfAborted } from '../src/infra/collection/collection-cancellation.js';
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
      upsertLots: async (lots, control) => {
        throwIfAborted(control?.signal);
        await control?.authorizePersistence?.();
        throwIfAborted(control?.signal);
        cenario.upsertChamadas++;
        const outcome = opcoes.upsert ? await opcoes.upsert(lots) : { upserted: lots.length, novos: [], bidChanges: [] };
        await control?.authorizePersistence?.();
        throwIfAborted(control?.signal);
        return outcome;
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

test('shutdown antes do commit aguarda rollback do upsert e termina com falha sem efeitos', async () => {
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
  let efeitos = 0;
  cenario.deps.processarAposColeta = async () => { efeitos++; return { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }; };
  const execucao = executeCollection(opcoesBase({ signal: controller.signal, publish: async () => { efeitos++; } }), cenario.deps);
  await upsertComecou.promise;
  controller.abort(new CollectionCancellationError('shutdown'));
  liberarUpsert.resolve();
  await assert.rejects(execucao, (error) => error instanceof CollectionCancellationError && error.kind === 'shutdown');
  assert.equal(cenario.finishChamadas.length, 1);
  assert.equal(cenario.finishChamadas[0].ok, false);
  assert.equal(cenario.finishChamadas[0].upserted, 0);
  assert.equal(efeitos, 0);
});

test('shutdown após commit preserva pós-coleta, finish e publicação; timeout só cobre conector', async () => {
  const controller = new AbortController();
  const cenario = montarDeps();
  const ordem: string[] = [];
  cenario.deps.upsertLots = async (_lots, control) => {
    assert.equal(control?.signal, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(control?.signal?.aborted, false, 'deadline encerrado do conector não vaza para persistência');
    controller.abort(new CollectionCancellationError('shutdown')); // Commit já concluído.
    return { upserted: 1, novos: [1], bidChanges: [] };
  };
  cenario.deps.processarAposColeta = async () => { ordem.push('post'); return { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }; };
  cenario.deps.finishRun = async (_id, data) => { assert.equal(data.ok, true); ordem.push('finish'); };
  await executeCollection(opcoesBase({ signal: controller.signal, timeoutMs: 10, publish: async () => { ordem.push('publish'); } }), cenario.deps);
  assert.deepEqual(ordem, ['post', 'finish', 'publish']);
});

test('falhas nos dois fechamentos preservam erro original, tentam finish e sanitizam logs', async () => {
  const original = new CollectionCancellationError('lock_lost');
  const cenario = montarDeps({
    connector: fonte(async () => ({ lots: [lote], fetched: 1, skipped: 0 })),
    upsert: async () => { throw original; },
  });
  const failures: string[] = [];
  let returned = 0;
  let finishes = 0;
  cenario.deps.observerForCollection = () => ({ start: async () => ({
    response() {}, failure(kind: string) { failures.push(kind); },
    async finish(stats: { returned: number }) { returned = stats.returned; throw new Error('postgres://secret@localhost/private'); },
  }) });
  cenario.deps.finishRun = async (_id, data) => {
    finishes++;
    assert.equal(data.ok, false);
    assert.equal(data.upserted, 0);
    throw new Error('redis://secret@localhost/private');
  };
  await assert.rejects(executeCollection(opcoesBase({ tenant: 'fixture.test', guaranteeTenantAttempt: true }), cenario.deps), error => error === original);
  assert.equal(finishes, 1);
  assert.equal(returned, 1, 'returned significa coletado, não persistido');
  assert.deepEqual(failures, ['network']);
  assert.equal(cenario.logErros.length, 2);
  assert.ok(cenario.logErros.every(([, error]) => !String(error).includes('secret')));
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
