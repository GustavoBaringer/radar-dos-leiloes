import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lotSiteHostSql } from '../src/core/repo.js';
import { toPublicFavorite, toPublicHit, toPublicLot } from '../src/core/public-dto.js';

test('DTO mantém crédito e inclui apenas dados de site disponíveis', () => {
  const row = { id: 1, source_id: 'tenant', lot_url: 'https://jrleiloes.com.br/lote', auctioneer_name: 'Crédito oficial', auctioneer_site_name: 'Joyce Ribeiro Leilões', auctioneer_domain: 'jrleiloes.com.br' };
  for (const item of [toPublicLot(row), toPublicFavorite({ ...row, favorited_em: new Date() }), toPublicHit({ ...row, labels: [] })]) {
    assert.equal(item.auctioneer_name, 'Crédito oficial');
    assert.equal(item.auctioneer_site_name, 'Joyce Ribeiro Leilões');
    assert.equal(item.auctioneer_domain, 'jrleiloes.com.br');
  }
  const absent = toPublicLot({ id: 2, source_id: 'tenant' });
  assert.equal(absent.auctioneer_site_name, undefined);
  assert.equal(absent.auctioneer_domain, undefined);
});

test('lookup e rotas de busca, alertas e favoritos projetam domínio/nome pelo mesmo SQL', () => {
  const sql = lotSiteHostSql('l.lot_url');
  assert.match(sql, /lower\(l\.lot_url\)/);
  assert.match(sql, /THEN substring\(l\.lot_url from 9\)/);
  assert.match(sql, /THEN substring\(l\.lot_url from 8\)/);
  assert.match(sql, /THEN [\s\S]* END\)/);
  const legacy = readFileSync(new URL('../src/legacy-host.ts', import.meta.url), 'utf8');
  const favorites = legacy.slice(legacy.indexOf("app.get('/api/favorites'"), legacy.indexOf("app.get('/api/" , legacy.indexOf("app.get('/api/favorites'") + 10));
  assert.match(favorites, /AS auctioneer_site_name/);
  assert.match(favorites, /AS auctioneer_domain/);
  assert.match(legacy, /AS auctioneer_site_name/); // home/cards and alerts/hits
  assert.match(legacy, /AS auctioneer_domain/);
});
