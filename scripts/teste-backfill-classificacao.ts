import test from 'node:test';
import assert from 'node:assert/strict';
import { groupChanges, identity, isJudicial, scopeAllows, validateChange } from './backfill-classificacao-filtros.js';
import { resolverCondicaoVlance } from '../src/core/campos.js';

const change = (overrides: Record<string, unknown> = {}) => ({
  id: 10611, source: 'vlance', externalId: '220905', field: 'vehicle_type', before: 'carro', after: 'moto',
  fingerprint: 'a'.repeat(64), evidence: { origin: 'fixture', rule: 'fixture' }, ...overrides,
});

test('judicial herdado é identificado sem depender do título do leilão', () => {
  assert.equal(isJudicial({ source_id: 'vlance', doc_type: 'judicial' }), true); // Hilux #10611
  assert.equal(isJudicial({ source_id: 'vlance', doc_type: 'judicial' }), true); // PRF sucata
  assert.equal(isJudicial({ source_id: 'leilo', doc_type: 'judicial' }), false);
  assert.equal(isJudicial({ source_id: 'vlance', doc_type: 'sucata' }), false);
});

test('identidade composta exige external id e leilão', () => {
  assert.deepEqual(identity({ lote_id: 220905, leilao_id: 100365 }), { externalId: '220905', leilaoId: '100365' });
  assert.equal(identity({ lote_id: 220905 }), null);
});

test('descrição rotulada mista é ambígua e não deve permitir fallback', () => {
  const text = 'Classificação: SUCATA. Condição: CONSERVADO.';
  const mixed = resolverCondicaoVlance({ assetType: 'veiculo', descricao: text, titulo: 'Honda CG', categoria: 'Moto' });
  assert.equal(mixed.docType, null);
  assert.equal(mixed.ambiguo, true);
  const clear = resolverCondicaoVlance({ assetType: 'veiculo', descricao: 'Classificação: SUCATA INSERVÍVEL.' });
  assert.equal(clear.docType, 'sucata');
  assert.equal(clear.origem, 'descricao');
  assert.equal(clear.ambiguo, false);
});

test('agrupa alterações por id para aplicar uma única vez', () => {
  const changes = [change(), change({ field: 'doc_type', before: 'judicial', after: 'sucata' })] as any[];
  const grouped = groupChanges(changes);
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get(10611)?.length, 2);
});

test('guardas de plano rejeitam source, campo e enum fora da allowlist', () => {
  assert.equal(validateChange(change()), true);
  assert.equal(validateChange(change({ source: 'copart' })), false);
  assert.equal(validateChange(change({ field: 'raw' })), false);
  assert.equal(validateChange(change({ after: 'onibus' })), false);
  assert.equal(validateChange(change({ id: '10611' })), false);
});

test('guardas de escopo só aceitam vlance/leilo em veículo', () => {
  assert.equal(scopeAllows('vlance', 'veiculo'), true);
  assert.equal(scopeAllows('leilo', 'veiculo'), true);
  assert.equal(scopeAllows('vlance', 'imovel'), false);
  assert.equal(scopeAllows('copart', 'veiculo'), false);
});
