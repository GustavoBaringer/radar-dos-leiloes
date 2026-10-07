import test from 'node:test';
import assert from 'node:assert/strict';
import { urlDoAlerta, estadoDaUrl } from './filtros';

/** O critério de verdade: a URL do alerta, lida de volta pela tela, reproduz os filtros. */
function confere(q: string | null, filters: Record<string, any>) {
  const url = urlDoAlerta({ q, filters });
  const qs = url.slice(url.indexOf('?') + 1);
  return { url, e: estadoDaUrl(qs) };
}

test('busca simples por texto', () => {
  const { url, e } = confere('volkswagen taos', {});
  assert.equal(e.q, 'volkswagen taos');
  assert.equal(url, '/busca?q=volkswagen+taos');
});

test('tipo de bem + valor mínimo/máximo + ano', () => {
  const { e } = confere('suv', { assetType: 'veiculo', priceMin: '30000', priceMax: '90000', yearMin: '2020', yearMax: '2024' });
  assert.equal(e.assetType, 'veiculo');
  assert.equal(e.priceMin, '30000');
  assert.equal(e.priceMax, '90000');
  assert.equal(e.yearMin, '2020');
  assert.equal(e.yearMax, '2024');
});

test('múltiplas facetas com vários valores', () => {
  const { e } = confere(null, { vehicleType: 'carro,suv', uf: 'SP,RJ,PR', sellerType: 'judicial', status: 'aberto,encerrado' });
  assert.deepEqual(e.multi.vehicleType, ['carro', 'suv']);
  assert.deepEqual(e.multi.uf, ['SP', 'RJ', 'PR']);
  assert.deepEqual(e.multi.sellerType, ['judicial']);
  assert.deepEqual(e.multi.status, ['aberto', 'encerrado']);
});

test('flags booleanas do alerta viram "1" na URL', () => {
  const { url, e } = confere('apartamento', { onlyWithPhoto: true, belowAppraisal: true, onlyWithDate: true });
  assert.equal(e.onlyWithPhoto, true);
  assert.equal(e.abaixo, true);
  assert.equal(e.onlyWithDate, true);
  assert.match(url, /onlyWithPhoto=1/);
  assert.match(url, /abaixo=1/);
});

test('abaixo pode vir como string "true" (JSON antigo)', () => {
  const { e } = confere(null, { belowAppraisal: 'true' });
  assert.equal(e.abaixo, true);
});

test('prazo do alerta entra na URL', () => {
  assert.equal(confere(null, { endsWithin: 'hoje' }).e.prazo, 'hoje');
  assert.equal(confere(null, { endsWithin: '7d' }).e.prazo, '7d');
  assert.equal(confere(null, { endsWithin: '30d' }).e.prazo, '');
});

test('localidade vira parâmetro local', () => {
  const { e } = confere(null, { place: 'c:SAO PAULO/SP' });
  assert.equal(e.local, 'c:SAO PAULO/SP');
});

test('combinação completa: texto + bem + facetas + flags + preço', () => {
  const { e } = confere('volkswagen', {
    assetType: 'veiculo', vehicleType: 'carro', yearMin: '2020', uf: 'PR,SC',
    sellerType: 'judicial', priceMax: '60000', belowAppraisal: true, onlyWithPhoto: true,
  });
  assert.equal(e.q, 'volkswagen');
  assert.equal(e.assetType, 'veiculo');
  assert.deepEqual(e.multi.vehicleType, ['carro']);
  assert.equal(e.yearMin, '2020');
  assert.deepEqual(e.multi.uf, ['PR', 'SC']);
  assert.deepEqual(e.multi.sellerType, ['judicial']);
  assert.equal(e.priceMax, '60000');
  assert.equal(e.abaixo, true);
  assert.equal(e.onlyWithPhoto, true);
});

test('alerta vazio cai na busca limpa', () => {
  const { url } = confere(null, {});
  assert.equal(url, '/busca');
});

test('chaves desconhecidas são ignoradas, não quebram', () => {
  const { e, url } = confere('gol', { foo: 'bar', __proto__: {} } as any);
  assert.equal(e.q, 'gol');
  assert.equal(url, '/busca?q=gol');
});
