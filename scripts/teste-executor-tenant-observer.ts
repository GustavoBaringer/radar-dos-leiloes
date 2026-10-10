import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, MockAgent } from 'undici';
import { pool } from '../src/core/db.js';
import { observerForCollection } from '../src/core/collection-observer.js';
import { executeCollection, type CollectionRunData } from '../src/core/collection-execution.js';
import type { UpsertOutcome } from '../src/core/repo.js';
import { vlance } from '../src/connectors/vlance.js';
import { leilotech } from '../src/connectors/leilotech.js';

const domains = [
  'www.leiloescentrooeste.com.br', 'www.alvaroleiloes.com.br', 'www.marcelolimaleiloes.com.br',
  'www.galvanileiloes.com.br', 'www.deonizialeiloes.com.br', 'api.leiloesjudiciais.com.br',
];

test('executor real encaminha observer real a conectores API/HTML, isola tenants e separa coleta de upsert', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const oldDispatch = Agent.prototype.dispatch;
  const oldQuery = pool.query;
  const oldVars = new Map(['TENANT_LEDGER_ENABLED', 'VLANCE_TENANTS', 'LEILOTECH_TENANTS'].map((name) => [name, process.env[name]]));
  const writes: Array<{ sql: string; params: any[] }> = [];
  const runs: Array<{ id: number; sourceId: string; data?: CollectionRunData }> = [];
  let attemptId = 0;
  let inMockDispatch = false;
  (Agent.prototype as any).dispatch = function (opts: any, handler: any) {
    if (inMockDispatch) return oldDispatch.call(this, opts, handler);
    inMockDispatch = true;
    try { return agent.dispatch(opts, handler); }
    finally { inMockDispatch = false; }
  };
  (pool as any).query = async (sql: string) => ({
    rows: sql.includes('discovered_sites') ? [] : [],
  });
  process.env.TENANT_LEDGER_ENABLED = '0';
  process.env.VLANCE_TENANTS = '1';
  process.env.LEILOTECH_TENANTS = '1';
  try {
    for (const [index, domain] of domains.entries()) {
      for (const tipo of [1, 3]) {
        agent.get(`https://${domain}`).intercept({
          path: `/core/api/get-lotes?tipo=${tipo}&qtd_por_pagina=5000`, method: 'POST',
        }).reply(index === 0 ? 404 : 200, JSON.stringify({ items: [] }));
      }
    }
    agent.get('https://arrematabem.com.br').intercept({ path: '/agenda' }).reply(200, '<html></html>');

    const observerExecute = async (sql: string, params: any[] = []) => {
      writes.push({ sql, params });
      if (sql.startsWith('INSERT')) return [{ id: ++attemptId }];
      return [{ id: params[0] }];
    };
    const deps = {
      lookupConnector: (sourceId: string) => sourceId === 'vlance' ? vlance : sourceId === 'leilotech' ? leilotech : undefined,
      startRun: async (sourceId: string) => {
        const id = runs.length + 1;
        runs.push({ id, sourceId });
        return id;
      },
      finishRun: async (id: number, data: CollectionRunData) => { runs.find((run) => run.id === id)!.data = data; },
      upsertLots: async (): Promise<UpsertOutcome> => {
        if (runs.at(-1)?.sourceId === 'leilotech') throw new Error('fixture upsert failure');
        return { upserted: 0, novos: [], bidChanges: [] };
      },
      observerForCollection: (context: any) => observerForCollection(context, true, observerExecute),
      processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
    };

    const scheduledAt = new Date('2026-10-10T12:00:00Z');
    await executeCollection({
      sourceId: 'vlance', limit: 100, metadata: { origin: 'cron', jobId: 'repeat:fixture', scheduledAt },
    }, deps);
    assert.equal(runs[0].data?.ok, true);
    const apiStarts = writes.filter((write) => write.sql.startsWith('INSERT'));
    const apiFinishes = writes.filter((write) => write.sql.startsWith('UPDATE'));
    assert.equal(apiStarts.length, domains.length);
    assert.deepEqual(apiStarts.slice(0, 2).map(({ params }) => params.slice(0, 5)), [
      [1, 'vlance', domains[0].replace(/^www\./, ''), 'cron', 'repeat:fixture'],
      [1, 'vlance', domains[1].replace(/^www\./, ''), 'cron', 'repeat:fixture'],
    ]);
    assert.equal(apiStarts[0].params[5], scheduledAt);
    assert.equal(apiFinishes[0].params[1], 'failed', 'HTTP 404 tenant is failed');
    assert.equal(apiFinishes[1].params[1], 'completed', `neighboring HTTP 200 tenant completes independently: ${JSON.stringify(apiFinishes.map(({ params }) => params))}`);

    await assert.rejects(executeCollection({
      sourceId: 'leilotech', limit: 10, metadata: { origin: 'refresh', jobId: 'refresh-fixture' },
    }, deps), /fixture upsert failure/);
    assert.equal(runs[1].data?.ok, false, 'upsert failure closes collection_run as failed');
    assert.equal(runs[1].data?.error, 'fixture upsert failure');
    const htmlStart = writes.filter((write) => write.sql.startsWith('INSERT')).at(-1)!;
    const htmlFinish = writes.filter((write) => write.sql.startsWith('UPDATE')).at(-1)!;
    assert.deepEqual(htmlStart.params.slice(0, 5), [2, 'leilotech', 'arrematabem.com.br', 'refresh', 'refresh-fixture']);
    assert.equal(htmlFinish.params[1], 'completed', 'real collector/observer records successful empty collection');
    assert.equal(runs[1].data?.upserted, 0);
    assert.equal(Object.hasOwn(runs[1].data ?? {}, 'persisted'), false, 'neither collection success nor run error asserts persistence');
  } finally {
    Agent.prototype.dispatch = oldDispatch;
    (pool as any).query = oldQuery;
    for (const [name, value] of oldVars) value === undefined ? delete process.env[name] : process.env[name] = value;
    await agent.close();
  }
});
