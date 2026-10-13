import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mapLot, TIPOS } from '../src/connectors/vlance.js';
import { guardTenantLots } from './coleta-tenant-audit.js';

/**
 * Contrato de proveniência dos tenants vlance jdleiloes.com.br e
 * franciscofreitasleiloes.com.br, com fixtures RECORTADAS de respostas JSON
 * públicas reais (POST /core/api/get-lotes, página 1) capturadas em
 * 2026-10-13T18:15Z. Ver fixtures/vlance/jdleiloes-franciscofreitas-recortes.json
 * para URL, timestamp UTC e sha256 do corpo original.
 */
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/vlance/jdleiloes-franciscofreitas-recortes.json', import.meta.url), 'utf8'),
) as {
  origens: Record<string, { url: string; capturadoEmUtc: string; httpStatus: number; sha256CorpoOriginal: string; totalItems: number }>;
  medidoTipos: Record<string, Record<string, { totalItems: number; categorias?: Record<string, number>; donos?: Record<string, number> }>>;
  itens: Record<string, any>;
};

test('fixtures trazem proveniência verificável (URL, UTC, sha256, HTTP 200)', () => {
  for (const [host, origem] of Object.entries(fixture.origens)) {
    assert.ok(origem.url.includes(host), host);
    assert.equal(origem.httpStatus, 200, host);
    assert.match(origem.capturadoEmUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, host);
    assert.equal(new Date(origem.capturadoEmUtc).getUTCFullYear(), 2026, host);
    assert.match(origem.sha256CorpoOriginal, /^[0-9a-f]{64}$/, host);
    assert.ok(origem.totalItems > 0, host);
  }
  // Dado pessoal de licitante não pode sobreviver nem na fixture.
  for (const [chave, item] of Object.entries(fixture.itens)) {
    assert.equal('nm_usuario' in item, false, chave);
    assert.equal('id_usuario' in item, false, chave);
  }
});

test('jdleiloes: imóvel e veículo mapeiam com dono coerente, mínimo e URL de 3 segmentos', () => {
  const imovel = mapLot(fixture.itens.imovel_jd, 'imovel', 'jdleiloes.com.br');
  assert.ok(imovel);
  assert.equal(imovel.assetType, 'imovel');
  assert.equal(imovel.status, 'aberto');
  assert.equal(imovel.minBid, 28574530.31);
  assert.equal(imovel.auctionEndUtc?.toISOString(), new Date('2026-10-26T23:59:00-03:00').toISOString());
  assert.match(String(imovel.lotUrl), /^https:\/\/www\.jdleiloes\.com\.br\/leilao\/index\/leilao_id\/\d+\/lote\/\d+$/);
  assert.equal(imovel.auctioneerName, 'José David Gonçalves de Melo');

  const veiculo = mapLot(fixture.itens.veiculo_jd, 'veiculo', 'jdleiloes.com.br');
  assert.ok(veiculo);
  assert.equal(veiculo.assetType, 'veiculo');
  assert.equal(veiculo.brand, 'FIAT');
  assert.equal(veiculo.minBid, 28000);
  // Categoria genérica "Veículos" não vira sourceCategory.
  assert.equal(veiculo.sourceCategory, null);
  assert.match(String(veiculo.lotUrl), /^https:\/\/www\.jdleiloes\.com\.br\/leilao\/index\/leilao_id\/\d+\/lote\/\d+$/);
});

test('conector só pede tipos 1 (veículos) e 3 (imóveis): "Animais" nunca vira veículo', () => {
  // MEDIDO em 2026-10-13: em jdleiloes tipo=1 devolve 4 veículos, tipo=3 devolve
  // 14 imóveis, e o catálogo completo (tipo=0) tem 20 itens, incluindo 2 de
  // "Animais" — que NÃO aparecem em nenhum dos tipos pedidos.
  assert.deepEqual(Object.entries(TIPOS), [['1', 'veiculo'], ['3', 'imovel']]);
  const medido = fixture.medidoTipos['jdleiloes.com.br'];
  assert.equal(medido.tipo1.totalItems, 4);
  assert.deepEqual(medido.tipo1.categorias, { 'Veículos': 4 });
  assert.equal(medido.tipo3.totalItems, 14);
  assert.deepEqual(medido.tipo3.categorias, { 'Imóveis': 14 });
  assert.equal(medido.tipo0.totalItems, 20);
  // Soma observada dos tipos pedidos: 4 + 14 = 18. Os 2 animais ficam fora.
  assert.equal(medido.tipo1.totalItems + medido.tipo3.totalItems, 18);
  assert.deepEqual(medido.tipo0.categorias, { 'Imóveis': 14, 'Veículos': 4, 'Animais': 2 });
  const animal = fixture.itens.animal_jd;
  assert.equal(animal.nm_categoria, 'Animais');
  assert.ok(Object.values(TIPOS).every(asset => asset === 'veiculo' || asset === 'imovel'));
});

test('franciscofreitasleiloes serve o catálogo de nortenordesteleiloes: guard barra persistência por host', () => {
  // MEDIDO: tipo=1 → 16 e tipo=3 → 74, todos com dono www.nortenordesteleiloes.com.br.
  const medido = fixture.medidoTipos['franciscofreitasleiloes.com.br'];
  assert.deepEqual(medido.tipo1.donos, { 'www.nortenordesteleiloes.com.br': 16 });
  assert.deepEqual(medido.tipo3.donos, { 'www.nortenordesteleiloes.com.br': 74 });
  assert.deepEqual(medido.tipo0.donos, { 'www.nortenordesteleiloes.com.br': 134 });

  const dono = fixture.itens.dono_divergente_ff;
  assert.equal(dono.nm_url_leiloeiro, 'www.nortenordesteleiloes.com.br');
  // mapLot monta lotUrl a partir do DONO, então o lote sai com URL do tenant
  // dono — não do host consultado. Não "consertar" com host errado.
  const lot = mapLot(dono, 'imovel', 'franciscofreitasleiloes.com.br');
  assert.ok(lot);
  assert.match(String(lot.lotUrl), /^https:\/\/www\.nortenordesteleiloes\.com\.br\//);
  const guard = guardTenantLots([lot], 'franciscofreitasleiloes.com.br', 90);
  assert.equal(guard.accepted.length, 0);
  assert.equal(guard.rejected.length, 1);
});
