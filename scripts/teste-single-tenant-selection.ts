import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTenantPopulation } from '../src/connectors/tenant-scheduler.js';
import { collectTenant } from '../src/core/single-tenant.js';

test('filterTenantPopulation: casa normalizado (www/caixa/ponto) e devolve o texto original da população', () => {
  const pop = ['WWW.Exemplo.com.br.', 'outro.com.br', 'exemplo.com.br'];
  assert.deepEqual(filterTenantPopulation(pop, 'exemplo.com.br'), ['WWW.Exemplo.com.br.']);
  assert.deepEqual(filterTenantPopulation(pop, 'www.exemplo.com.br'), ['WWW.Exemplo.com.br.']);
  assert.deepEqual(filterTenantPopulation(pop, 'EXEMPLO.com.br.'), ['WWW.Exemplo.com.br.']);
});

test('filterTenantPopulation: tenant fora da população (ou entrada vazia) devolve lista vazia — nunca "coletar tudo"', () => {
  const pop = ['a.com.br', 'b.com.br'];
  assert.deepEqual(filterTenantPopulation(pop, 'c.com.br'), []);
  assert.deepEqual(filterTenantPopulation([], 'a.com.br'), []);
  assert.deepEqual(filterTenantPopulation(pop, ''), []);
  assert.deepEqual(filterTenantPopulation(pop, '   '), []);
  assert.deepEqual(filterTenantPopulation(pop, '...'), []);
});

test('collectTenant: recusa sourceId desconhecido e tenant vazio ANTES de qualquer coleta', async () => {
  await assert.rejects(collectTenant('fonte-inexistente', 'a.com.br', { limit: 1 }), /desconhecido/);
  await assert.rejects(collectTenant('soleon', '  ', { limit: 1 }), /obrigat/);
});

test('collectTenant: repassa tenant normalizado ao conector sem reimplementar o parser da fonte', async () => {
  const { soleon } = await import('../src/connectors/soleon.js');
  const original = soleon.collect;
  let recebido: { tenant?: string; limit: number } | undefined;
  soleon.collect = async (opts) => {
    recebido = opts;
    return { lots: [], fetched: 0, skipped: 0 };
  };
  try {
    const res = await collectTenant('soleon', ' leiloeiro.com.br ', { limit: 7 });
    assert.deepEqual(res, { lots: [], fetched: 0, skipped: 0 });
    assert.equal(recebido?.tenant, 'leiloeiro.com.br');
    assert.equal(recebido?.limit, 7);
  } finally {
    soleon.collect = original;
  }
});
