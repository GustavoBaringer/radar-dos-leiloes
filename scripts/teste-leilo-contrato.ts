import assert from 'node:assert/strict';
import { LEILO_TIPOS, mapLot } from '../src/connectors/leilo.js';

// Field names and values captured from public API result for linked home card
// /lote/4b1c7b54-b85e-11f1-b169-02420a000008/ (2026-10-14).
const property = mapLot({
  id: '4b1c7b54-b85e-11f1-b169-02420a000008',
  nome: 'Marituba/PA - Terreno com 21.250 m²',
  tipo: 'Imoveis',
  situacao: 'LiberadoLeilao',
  dataFim: '2026-10-16T12:30:00.000Z',
  leilao: { id: '4804', nome: 'Leilão do Banco Luso Marituba', data: '2026-10-16T12:30:00.000Z' },
  localizacao: { cidade: 'Marituba', estado: 'PA' },
  valor: { minimo: 21250 },
}, new Map([['4804', { nome: 'Leilo', inscricao: null }]]));

assert.ok(property);
assert.equal(property.sourceCategory, 'Imoveis');
assert.equal(property.status, 'aberto');
assert.equal(property.externalId, '4b1c7b54-b85e-11f1-b169-02420a000008');
assert.equal(property.lotUrl, 'https://www.leilo.com.br/lote/4b1c7b54-b85e-11f1-b169-02420a000008/?leilao.nome=Leil%C3%A3o+do+Banco+Luso+Marituba&tipo=Imoveis&tipoLista=Imoveis');
assert.ok(LEILO_TIPOS.includes('Imoveis'));
assert.ok(!LEILO_TIPOS.includes('Sucatas' as never));

assert.equal(mapLot({ id: 'part-1', nome: 'Lote de peças diversas', tipo: 'Carros', leilao: { id: 'l1', nome: 'Leilão' } }, new Map()), null);
