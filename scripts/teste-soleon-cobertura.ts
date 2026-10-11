import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { classifyAsset, classifyProperty } from '../src/core/normalize.js';
import { assinaturaPagina, dataLeilaoUtc, lerCards, novosCards, ROTAS_CATEGORIAS } from '../src/connectors/soleon.js';

const card = (id: number, title: string, status: string, description: string) => `
<div class="lote"><h4>Lote 001</h4>
 <a href="/item/${id}/detalhes?page=1" style="background:url('/photo.jpg')"></a>
 <h5>${title}</h5><div style="text-align: justify !important"><b>Descrição:</b> ${description}</div>
 <div class="label_lote ${status}">Aguarde Abertura</div><div class="etiqueta">Lance Inicial</div>
 <h4>R$18.801,60</h4></div>`;

assert.deepEqual(ROTAS_CATEGORIAS, ['/lotes/veiculo?tipo=veiculo', '/lotes/imovel?tipo=imovel']);
assert.equal(dataLeilaoUtc('Leilão:15/10/2026 às23:00')?.toISOString(), '2026-10-16T02:00:00.000Z');
assert.equal(dataLeilaoUtc('Leilão:31/02/2026 às23:00'), null, 'data de calendário inválida não deve rolar para março');

const imovelHtml = card(6155,
  '01 (UM) TERRENO NO LOTEAMENTO VILLA VERDE - SÃO CRISTOVÃO - CAPELA/SE',
  'aguarde_abertura', 'Terreno urbano. Executado: João da Silva.');
const imovel = lerCards(cheerio.load(imovelHtml), 'argleiloes.com.br')[0];
assert.ok(imovel);
assert.equal(imovel.itemId, '6155');
assert.equal(imovel.status, 'agendado');
assert.equal(imovel.titulo, '01 (UM) TERRENO NO LOTEAMENTO VILLA VERDE - SÃO CRISTOVÃO - CAPELA/SE');
assert.equal(classifyAsset(imovel.titulo, 'imovel').assetType, 'imovel');
assert.equal(classifyProperty(imovel.titulo, 'imovel'), 'terreno');
assert.doesNotMatch(imovel.titulo, /João da Silva/);
const imovelGenerico = lerCards(cheerio.load(card(6156, 'Imóvel', 'aguarde_abertura', 'Casa residencial em Capela/SE.')),
  'argleiloes.com.br')[0];
assert.equal(imovelGenerico.titulo, 'Casa residencial em Capela/SE.');
assert.equal(classifyProperty(imovelGenerico.titulo, 'imovel'), 'casa');

const veiculoHtml = card(42, 'FIAT UNO MILLE 2008/2009', 'aberto_lance', 'Marca / Modelo: FIAT UNO Placa: ABC1234');
const vehicle = lerCards(cheerio.load(veiculoHtml), 'realizaleiloes.com.br')[0];
assert.ok(vehicle);
assert.equal(vehicle.status, 'aberto');
assert.equal(classifyAsset(vehicle.titulo, 'veiculo').assetType, 'veiculo');
assert.equal(classifyProperty(vehicle.titulo, 'veiculo'), null);

const vistos = new Set<string>();
assert.equal(novosCards(lerCards(cheerio.load(imovelHtml), 'argleiloes.com.br'), vistos).length, 1);
assert.equal(novosCards(lerCards(cheerio.load(imovelHtml + veiculoHtml), 'argleiloes.com.br'), vistos).length, 1,
  'ID repetido em outra página/categoria deve ser descartado');
const paginaVeiculos = lerCards(cheerio.load(card(42, 'FIAT UNO', 'aberto_lance', '')), 'argleiloes.com.br');
assert.equal(assinaturaPagina(paginaVeiculos), '42');
assert.equal(assinaturaPagina(paginaVeiculos), assinaturaPagina(paginaVeiculos), 'assinatura estável permite encerrar paginação repetida');
assert.notEqual(assinaturaPagina(paginaVeiculos), assinaturaPagina(lerCards(cheerio.load(card(6155, 'Casa', 'aguarde_abertura', '')), 'argleiloes.com.br')),
  'assinaturas são locais à categoria; sobreposição de IDs entre categorias não encerra ambas');
console.log('SOLEON cobertura: imóveis, veículo, aguardando e deduplicação OK');
