import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLot } from '../src/connectors/vlance.js';
import * as campos from '../src/core/campos.js';

const base = {
  lote_id: 220905,
  leilao_id: 17,
  nm_titulo_lote: 'Hilux CD 4x4 2018',
  nm_titulo_leilao: 'LEILÃO DA SUPERINTENDÊNCIA DA POLÍCIA RODOVIÁRIA FEDERAL - SUCATA INSERVÍVEL',
  nm_descricao: 'Classificação SUCATA INSERVÍVEL. Licitante: Pessoa Teste, CPF 000.000.000-00',
  nm_categoria: 'Veículos',
  nm_usuario: 'Licitante Pessoa',
  id_usuario: 123,
};

test('V-Lance usa classificação rotulada e não persiste a descrição ou licitante', () => {
  const lot = mapLot(base, 'veiculo', 'api.leiloesjudiciais.com.br');
  assert.ok(lot);
  assert.equal(lot.docType, 'sucata');
  const raw = lot.raw as Record<string, unknown>;
  assert.equal(raw.classificacao, 'sucata');
  assert.equal(raw.classificacaoOrigem, 'descricao');
  assert.equal(lot.sourceCategory, null);
  assert.doesNotMatch(JSON.stringify(lot), /Pessoa Teste|000\.000|Licitante Pessoa/);
  assert.equal(JSON.stringify(lot).includes(base.nm_descricao), false);
});

test('classificação conservado explícita prevalece sobre edital sucata e fallback misto é nulo', () => {
  const resolvido = campos.resolverCondicaoVlance({
    descricao: 'Classificação CONSERVADO',
    titulo: 'Yamaha Fazer',
    edital: 'Leilão de veículos conservados e sucata inservível',
  });
  assert.deepEqual(resolvido, { docType: 'conservado', classificacao: 'conservado', origem: 'descricao', ambiguo: false });
  assert.deepEqual(campos.resolverCondicaoVlance({ edital: 'Veículos conservados e sucata inservível' }), {
    docType: null, classificacao: null, origem: null, ambiguo: true,
  });
  assert.deepEqual(campos.resolverCondicaoVlance({ titulo: 'Yamaha Fazer', categoria: 'Veículos', edital: 'Leilão judicial', classificacao: 'conservado', classificacaoOrigem: 'descricao' }), {
    docType: 'conservado', classificacao: 'conservado', origem: 'classificacao', ambiguo: false,
  });
});

test('roundtrip de todos os valores canônicos e origem edital não prova condição individual', () => {
  const conditions: campos.CondicaoVlance[] = ['sucata', 'conservado', 'sinistrado', 'recuperado_financiamento'];
  for (const value of conditions) {
    assert.equal(campos.resolverCondicaoVlance({ classificacao: value, classificacaoOrigem: 'lote' }).classificacao, value);
  }
  assert.equal(campos.resolverCondicaoVlance({ classificacao: 'sucata', classificacaoOrigem: 'edital' }).classificacao, null);
  for (const label of ['Classificação SUCATA APROVEITÁVEL', 'Classificação SUCATA SERVÍVEL']) {
    assert.equal(campos.resolverCondicaoVlance({ descricao: label }).classificacao, 'sucata');
  }
});

test('rótulos conflitantes, valores com boilerplate e negações bloqueiam fallbacks', () => {
  for (const descricao of [
    'Classificação CONSERVADO<br>Classificação SUCATA INSERVÍVEL',
    'Classificação CONSERVADO. Considera-se sucata nos termos da lei',
    'Classificação não é sucata',
    'Classificação CONSERVADO não é sucata',
  ]) {
    const result = campos.resolverCondicaoVlance({ descricao, edital: 'Leilão judicial - sucata' });
    assert.equal(result.classificacao, null, descricao);
    assert.equal(result.ambiguo, true, descricao);
  }
  const ambiguousLot = mapLot({ ...base, nm_descricao: 'Classificação CONSERVADO<br>Classificação SUCATA INSERVÍVEL' }, 'veiculo', 'x.test');
  assert.ok(ambiguousLot);
  assert.equal(ambiguousLot.docType, null, 'não aplicar fallback judicial em lote ambíguo');
});

test('categoria genérica não infere condição; negações e boilerplate legal não inferem sucata', () => {
  assert.equal(campos.resolverCondicaoVlance({ categoria: 'Veículos' }).docType, null);
  assert.equal(campos.resolverCondicaoVlance({ titulo: 'Veículo servível' }).docType, null);
  assert.equal(campos.resolverCondicaoVlance({ titulo: 'Veículo não é sucata' }).docType, null);
  assert.equal(campos.resolverCondicaoVlance({ titulo: 'Veículo sem baixa obrigatória' }).docType, null);
  assert.equal(campos.resolverCondicaoVlance({ edital: 'Na hipótese de sucata, aplicar-se-á a legislação vigente' }).docType, null);
});

test('condição inequívoca do lote, imóveis judiciais e fallback judicial', () => {
  assert.equal(campos.resolverCondicaoVlance({ titulo: 'VW Gol sucata para desmonte' }).docType, 'sucata');
  const car = mapLot({ ...base, nm_descricao: 'Classificação CONSERVADO', nm_titulo_leilao: 'Leilão judicial' }, 'veiculo', 'x.test');
  assert.ok(car);
  assert.equal(car.docType, 'conservado');
  const property = mapLot({ ...base, nm_titulo_lote: 'Casa', nm_descricao: '', nm_titulo_leilao: 'Leilão judicial', nm_categoria: 'Imóveis' }, 'imovel', 'x.test');
  assert.ok(property);
  assert.equal(property.docType, 'judicial');
  const propertyWithVehicleClass = mapLot({ ...base, nm_titulo_lote: 'Casa', nm_descricao: 'Classificação SUCATA INSERVÍVEL', nm_categoria: 'Imóveis' }, 'imovel', 'x.test');
  assert.ok(propertyWithVehicleClass);
  assert.equal(propertyWithVehicleClass.docType, 'judicial');
  assert.equal((propertyWithVehicleClass.raw as Record<string, unknown>).classificacao, null);
  const ordinary = mapLot({ ...base, nm_descricao: '', nm_titulo_leilao: 'Leilão judicial' }, 'veiculo', 'x.test');
  assert.ok(ordinary);
  assert.equal(ordinary.docType, 'judicial');
  const mixedTitle = mapLot({ ...base, nm_titulo_lote: 'Gol conservado / sucata', nm_descricao: '', nm_titulo_leilao: 'Leilão judicial' }, 'veiculo', 'x.test');
  assert.ok(mixedTitle);
  assert.equal(mixedTitle.docType, null);
});

test('docType não confunde sucata com judicial e extrajudicial com judicial', () => {
  assert.equal(campos.docType('judicial - sucata inservível'), 'sucata');
  assert.equal(campos.docType('recuperado de financiamento - sucata'), 'sucata');
  assert.equal(campos.docType('leilão extrajudicial'), 'extrajudicial');
  assert.equal(campos.docType('contrato recuperado de financiamento'), 'recuperado_financiamento');
});
