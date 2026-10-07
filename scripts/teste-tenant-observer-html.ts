import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, MockAgent } from 'undici';
import { pool } from '../src/core/db.js';
import { createTenantObserver } from '../src/core/tenant-attempts.js';
import { soleon } from '../src/connectors/soleon.js';
import { leilaopro } from '../src/connectors/leilaopro.js';
import { leilotech } from '../src/connectors/leilotech.js';
import { htmlagenda } from '../src/connectors/htmlagenda.js';

const originals = new Map<string, string | undefined>();
const env = (name: string, value: string) => {
  if (!originals.has(name)) originals.set(name, process.env[name]);
  process.env[name] = value;
};
const host = (n: number) => `fixture${n}.test`;

async function runOffline(run: (agent: MockAgent, attempts: any[], querySql: string[]) => Promise<void>) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const attempts: any[] = [], querySql: string[] = [];
  const oldDispatch = Agent.prototype.dispatch;
  const oldQuery = pool.query;
  const oldTimeout = globalThis.setTimeout;
  let inMockDispatch = false;
  (Agent.prototype as any).dispatch = function (opts: any, handler: any) {
    if (inMockDispatch) return oldDispatch.call(this, opts, handler);
    inMockDispatch = true;
    try { return agent.dispatch(opts, handler); }
    finally { inMockDispatch = false; }
  };
  (pool as any).query = async (sql: string) => {
    querySql.push(sql);
    return { rows: sql.includes('discovered_sites') ? [{ domain: host(1) }] : [] };
  };
  (globalThis as any).setTimeout = (fn: (...args: any[]) => void) => { queueMicrotask(fn); return 0; };
  try { await run(agent, attempts, querySql); }
  finally {
    Agent.prototype.dispatch = oldDispatch;
    (pool as any).query = oldQuery;
    globalThis.setTimeout = oldTimeout;
    await agent.close();
    for (const [key, value] of originals) value === undefined ? delete process.env[key] : process.env[key] = value;
    originals.clear();
  }
}

function ledger(attempts: any[]) {
  let id = 1;
  return createTenantObserver({ runId: 1, sourceId: 'fixture', origin: 'manual' }, async (sql, params = []) => {
    if (sql.startsWith('INSERT')) { attempts.push({ start: params }); return [{ id: id++ }]; }
    attempts.push({ finish: params }); return [{ id: params[0] }];
  });
}

function htmlFallback(agent: MockAgent, tenant: string) {
  const scope = agent.get(`https://${tenant}`);
  for (let i = 0; i < 20; i++) scope.intercept({ path: /.*/ }).reply(200, '<html></html>');
}

test('SOLEON records completed empty tenant from its actual collector', async () => {
  await runOffline(async (agent, attempts) => {
    env('SOLEON_DOMAINS', host(1)); env('SOLEON_TENANTS', '1');
    agent.get(`https://${host(1)}`).intercept({ path: '/lotes/veiculo?tipo=veiculo&page=1' }).reply(200, '<html></html>');
    const result = await soleon.collect({ limit: 10, observer: ledger(attempts) });
    assert.equal(result.lots.length, 0);
    assert.equal(attempts[1].finish[1], 'completed', JSON.stringify(attempts));
  });
});

test('Leilão PRO and Leilotech record list requests without real database/network', async () => {
  await runOffline(async (agent, attempts) => {
    env('LEILAOPRO_TENANTS', '1');
    agent.get(`https://${host(1)}`).intercept({ path: '/leilao/lotes/veiculos' }).reply(200, '<html></html>');
    agent.get(`https://${host(1)}`).intercept({ path: '/leilao/lotes/maquinas' }).reply(200, '<html></html>');
    agent.get(`https://${host(1)}`).intercept({ path: '/leilao/lotes/imoveis' }).reply(200, '<html></html>');
    const pro = await leilaopro.collect({ limit: 10, observer: ledger(attempts) });
    assert.equal(pro.lots.length, 0);
    assert.equal(attempts[1].finish[1], 'completed', JSON.stringify(attempts));
  });
  await runOffline(async (agent, attempts) => {
    env('LEILOTECH_TENANTS', '1');
    agent.get('https://arrematabem.com.br').intercept({ path: '/agenda' }).reply(200, '<html></html>');
    const result = await leilotech.collect({ limit: 10, observer: ledger(attempts) });
    assert.equal(result.lots.length, 0);
    assert.equal(attempts[1].finish[1], 'completed', JSON.stringify(attempts));
  });
});

test('HTML Agenda records all-filtered results and stops before starting the next tenant at limit', async () => {
  await runOffline(async (agent, attempts) => {
    env('HTMLAGENDA_DOMAINS', host(1));
    agent.get(`https://${host(1)}`).intercept({ path: '/' }).reply(200, '<a href="/lote/quadro-de-arte">lote</a>');
    agent.get(`https://${host(1)}`).intercept({ path: '/lote/quadro-de-arte' }).reply(200, '<h1>Quadro de arte</h1>');
    htmlFallback(agent, host(1));
    const result = await htmlagenda.collect({ limit: 10, observer: ledger(attempts) });
    assert.equal(result.fetched, 1, JSON.stringify({ result, attempts })); assert.equal(result.skipped, 1); assert.equal(result.lots.length, 0);
    assert.equal(attempts[1].finish[1], 'completed', JSON.stringify(attempts));
  });
  await runOffline(async (agent, attempts) => {
    env('HTMLAGENDA_DOMAINS', `${host(1)},${host(2)}`);
    agent.get(`https://${host(1)}`).intercept({ path: '/' }).reply(200, '<a href="/lote/apartamento-rio-de-janeiro">lote</a>');
    agent.get(`https://${host(1)}`).intercept({ path: '/lote/apartamento-rio-de-janeiro' }).reply(200, '<h1>Apartamento em Rio de Janeiro</h1>');
    htmlFallback(agent, host(1));
    const result = await htmlagenda.collect({ limit: 1, observer: ledger(attempts) });
    assert.equal(result.lots.length, 1);
    assert.equal(attempts.filter((row) => row.start).length, 1);
    assert.equal(attempts[1].finish[1], 'partial');
    assert.equal(attempts[1].finish[7], 'budget');
  });
});

test('HTML Agenda records partial mapped result on inaccessible detail; insert failure precedes HTTP', async () => {
  await runOffline(async (agent, attempts) => {
    env('HTMLAGENDA_DOMAINS', host(1));
    agent.get(`https://${host(1)}`).intercept({ path: '/' }).reply(200, '<a href="/lote/apartamento-rio">lote</a>');
    agent.get(`https://${host(1)}`).intercept({ path: '/lote/apartamento-rio' }).reply(404, '');
    htmlFallback(agent, host(1));
    const result = await htmlagenda.collect({ limit: 10, observer: ledger(attempts) });
    assert.equal(result.lots.length, 1);
    assert.equal(attempts[1].finish[1], 'partial');
  });
  await runOffline(async (agent, attempts) => {
    env('HTMLAGENDA_DOMAINS', host(1));
    const scope = agent.get(`https://${host(1)}`);
    scope.intercept({ path: /.*/ }).reply(200, '<html></html>');
    await assert.rejects(htmlagenda.collect({ limit: 10, observer: createTenantObserver(
      { runId: 1, sourceId: 'fixture', origin: 'manual' }, async () => { throw new Error('ledger unavailable'); },
    ) }));
    assert.equal(agent.pendingInterceptors().length, 1);
    assert.equal(attempts.length, 0);
  });
});

test('SOLEON caught network error is recorded as failed, with offline retries only', async () => {
  await runOffline(async (agent, attempts) => {
    env('SOLEON_DOMAINS', host(1)); env('SOLEON_TENANTS', '1');
    agent.get(`https://${host(1)}`).intercept({ path: '/lotes/veiculo?tipo=veiculo&page=1' }).replyWithError(new Error('fixture network error'));
    const result = await soleon.collect({ limit: 10, observer: ledger(attempts) });
    assert.equal(result.lots.length, 0);
    assert.equal(attempts[1].finish[1], 'failed');
    assert.equal(attempts[1].finish[7], 'network');
  });
});
