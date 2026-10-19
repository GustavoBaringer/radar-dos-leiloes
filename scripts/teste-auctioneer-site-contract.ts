import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auctioneerSiteNameSql, lotSiteHostSql } from '../src/core/repo.js';
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

test('nome do site só existe quando o domínio pertence a um único nome', () => {
  const sql = auctioneerSiteNameSql();
  // Um domínio com vários deeloeiros declarando-o é plataforma compartilhada:
  // escolher um deles (o primeiro em ordem alfabética) atribuía a pessoa errada.
  assert.match(sql, /count\(DISTINCT a\.name\) = 1/);
  assert.doesNotMatch(sql, /ORDER BY a\.name LIMIT 1/);
  assert.match(sql, /lower\(regexp_replace\(a\.domain, '\^www\[\.\]', ''\)\)/);
  assert.match(sql, /a\.name IS NOT NULL AND a\.name <> ''/);
  assert.match(sql, /min\(a\.name\)/);

  // Nenhuma consulta pode voltar ao antigo: o ORDER BY LIMIT 1 sem contagem.
  for (const arquivo of ['../src/infra/database/repositories/lots.repository.ts', '../src/legacy-host.ts']) {
    const texto = readFileSync(new URL(arquivo, import.meta.url), 'utf8');
    assert.doesNotMatch(texto, /SELECT a\.name FROM auctioneers/,
      `${arquivo} ainda tem o subselect que escolhe um nome ao acaso`);
    assert.match(texto, /auctioneerSiteNameSql\(/, `${arquivo} não usa o SQL único de nome do site`);
  }
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
