import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aspItemIds, blockedPageError, isAspCatalogInScope, isAspLotEligible, isBlockedPage, reviewedTenant, selectTenantPopulation } from '../src/connectors/htmlagenda.js';

test('reviewed tenant overrides discovery eligibility but refuses unreviewed domains', () => {
  assert.equal(reviewedTenant('www.C3LEILOES.com.br'), 'c3leiloes.com.br');
  assert.equal(reviewedTenant('tbaracajuleiloes.com.br'), 'tbaracajuleiloes.com.br');
  assert.throws(() => reviewedTenant('other.com.br'), /fora da população revisada/);
  assert.deepEqual(selectTenantPopulation(['existing-auctioneer.com.br'], 'existing-auctioneer.com.br'), ['existing-auctioneer.com.br']);
  assert.throws(() => selectTenantPopulation(['existing-auctioneer.com.br'], 'unknown.com.br'), /fora da população elegível/);
  assert.throws(() => selectTenantPopulation(['existing-auctioneer.com.br'], ''), /inválido/);
});

test('ASP catalog scope is conservative and rejects collectible evidence', () => {
  assert.equal(isAspCatalogInScope('Leilão de máquinas e equipamentos'), true);
  assert.equal(isAspCatalogInScope('Leilão de Numismática, Filatelia, Cartões Postais, Eucalol, Brinquedos e Afins'), false);
  assert.equal(isAspLotEligible('Equipamento escavadeira Caterpillar 320'), true);
  assert.equal(isAspLotEligible('Motor do veículo'), false);
  assert.equal(isAspLotEligible('Carrinho de brinquedo'), false);
});

test('HTTP 200 application block is detected as blocked content', () => {
  assert.equal(isBlockedPage('<h1>Sistema indisponível</h1>'), true);
  assert.equal(isBlockedPage('<h1>Leilões disponíveis</h1>'), false);
  assert.match(blockedPageError().message, /bloqueio\/aplicação indisponível/);
});

test('ASP lot links are case-insensitive and deduplicated', () => {
  assert.deepEqual(aspItemIds('<a href="/peca.asp?id=12">A</a><a href="/peca.asp?ID=12">B</a><a href="/peca.asp?Num=2&Id=13">C</a>'), ['12', '13']);
});
