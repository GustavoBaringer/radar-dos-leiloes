import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionContext } from '../src/bootstrap/collection-context.js';
import type { CollectionExecutionDependencies } from '../src/application/services/collection/collection.service.js';
import type { CandidatoVerificacao, LotClosureRepositoryPort } from '../src/infra/database/repositories/lot-closure.repository.js';
import type { Verificador } from '../src/domain/lots/verification.js';

function repository(candidates: CandidatoVerificacao[] = []) {
  const events: unknown[] = [];
  const port: LotClosureRepositoryPort = {
    encerrarPorPrazo: async () => { events.push('deadline'); return 2; },
    encerrarPorAusencia: async (...args) => { events.push(['absence', ...args]); return 3; },
    candidatos: async (...args) => { events.push(['candidates', ...args]); return candidates; },
    aplicarVereditos: async (...args) => { events.push(['verdicts', ...args]); },
    corrigirPrazo: async (...args) => { events.push(['deadlines', ...args]); },
  };
  return { port, events };
}

const collectionDeps: CollectionExecutionDependencies = {
  lookupConnector: () => undefined,
  startRun: async () => 1,
  finishRun: async () => undefined,
  upsertLots: async () => ({ upserted: 0, bidChanges: [], novos: [] }),
  observerForCollection: () => undefined,
  processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
};

test('complete fake collection and closure ports compose headlessly without DB or HTTP', async () => {
  const repo = repository();
  const context = await createCollectionContext({
    dependencies: collectionDeps,
    closureDependencies: { repository: repo.port, verifiers: {} },
  });
  try {
    assert.ok(context.closure);
    assert.equal(context.app.get(context.closure!.constructor), context.closure);
    assert.deepEqual(await context.closure!.encerrarLotes(), { porPrazo: 2, porAusencia: 0 });
    assert.deepEqual(repo.events, ['deadline'], 'absence remains disabled unless explicitly opted in at module load');
  } finally { await context.close(); }
});

test('verification groups by host, preserves all verdict outcomes and records source deadlines', async () => {
  const candidates: CandidatoVerificacao[] = [
    { id: '101', source_id: 'fake', external_id: 'gone', lot_url: 'https://same.example/lote/1', source_category: null },
    { id: '102', source_id: 'fake', external_id: 'live', lot_url: 'https://same.example/lote/2', source_category: null },
    { id: '103', source_id: 'fake', external_id: 'missing', lot_url: null, source_category: null },
    { id: '104', source_id: 'fake', external_id: 'error', lot_url: 'https://other.example/lote/4', source_category: null },
  ];
  const repo = repository(candidates);
  let calls = 0;
  const verifier: Verificador = {
    porHost: false,
    async verificar(host, lots) {
      calls++;
      if (host === 'other.example') throw new Error('fixture verifier error');
      if (host === '(sem-url)-fake') return new Map([[103, { veredito: 'agendado', sinal: 'Aguarde abertura' }]]);
      assert.equal(host, 'same.example');
      assert.deepEqual(lots.map((lot) => lot.id), [101, 102]);
      return new Map([
        [101, { veredito: 'sumiu', sinal: 'HTTP 404' }],
        [102, { veredito: 'aberto', sinal: 'Recebendo', fimUtc: '2027-01-01T00:00:00.000Z' }],
      ]);
    },
  };
  const context = await createCollectionContext({
    dependencies: collectionDeps,
    closureDependencies: { repository: repo.port, verifiers: { fake: verifier } },
  });
  try {
    const result = await context.closure!.verificarCandidatos(17);
    assert.deepEqual(result, { verificados: 4, encerrados: 1, vivos: 2, indeterminados: 1 });
    assert.equal(calls, 3, 'one verifier invocation per source+host group');
    const verdictEvent = repo.events.find((event) => Array.isArray(event) && event[0] === 'verdicts') as any[];
    assert.deepEqual(verdictEvent[1].map((item: any) => item.id), [101]);
    assert.deepEqual(verdictEvent[2].map((item: any) => item.id), [102, 103]);
    assert.deepEqual(verdictEvent[3], [{ id: 104, veredito: 'indeterminado', sinal: 'fixture verifier error' }]);
    const deadlineEvent = repo.events.find((event) => Array.isArray(event) && event[0] === 'deadlines') as any[];
    assert.deepEqual(deadlineEvent[1], [{ id: 102, veredito: 'aberto', sinal: 'Recebendo', fimUtc: '2027-01-01T00:00:00.000Z' }]);
  } finally { await context.close(); }
});
