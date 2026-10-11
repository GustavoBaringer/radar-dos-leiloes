import assert from 'node:assert/strict';
import test from 'node:test';
import { pool, query } from '../src/core/db.js';
import { LOT_SITE_HOST_SQL, searchLots } from '../src/core/repo.js';

test('sourceSite filtra hostname real com OR e a própria faceta não se auto-restringe', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  await searchLots({ sourceSite: ['WWW.auctions.com.br', 'site2.com'] }, async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)::int AS count FROM lots')) return [{ count: 2 }];
    return [];
  });

  const list = calls.find(({ sql }) => sql.includes('COUNT(*)::int AS count FROM lots'))!;
  assert.match(list.sql, /\) = ANY\(\$1\)/);
  assert.deepEqual(list.params, [['auctions.com.br', 'site2.com']]);

  const sites = calls.find(({ sql }) => sql.includes('AS label') && sql.includes('chr(63)'))!;
  assert.equal(sites.params.length, 0);
  assert.doesNotMatch(sites.sql.slice(sites.sql.indexOf('FROM lots')), /WHERE[^]*?\$\d/);
  assert.doesNotMatch(sites.sql, /LIMIT\s+\d+/i);
  assert.match(sites.sql, /GROUP BY 1 ORDER BY 2 DESC, 1/);
});

test('Postgres extrai hostname real de URLs e busca por site (read-only)', async (t) => {
  const urls = [
    'http://foo.com:80/lote/1',
    'https://WWW.foo.com:443/path?x=1#frag',
    'https://foo.com?x=1',
    'https://www.bar.com/#lote',
    'ftp://foo.com/lote',
    'https://foo..com/path',
    'https://bad_host.com/',
    'https://foo.com:bad/path',
  ];
  try {
    try {
      await query('SELECT 1');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code ?? '')) {
        t.skip(`Postgres indisponível (${code})`);
        return;
      }
      throw error;
    }

    const values = urls.map((_, i) => `($${i + 1}::text)`).join(',');
    const extracted = await query<{ lot_url: string; host: string | null }>(
      `WITH lots(lot_url) AS (VALUES ${values}) SELECT lot_url, ${LOT_SITE_HOST_SQL} AS host FROM lots`,
      urls,
    );
    assert.deepEqual(extracted.map((row) => row.host), [
      'foo.com', 'foo.com', 'foo.com', 'bar.com', null, null, null, null,
    ]);

    const all = await searchLots({ pageSize: 1 });
    const site = all.facets.sites[0];
    if (!site) {
      t.skip('Sem lotes elegíveis para validar a busca real por site');
      return;
    }
    assert.equal(site.value, site.label);
    const filtered = await searchLots({ sourceSite: site.value, pageSize: 24 });
    assert.equal(filtered.total, site.count);
    assert.ok(filtered.items.length > 0);
    for (const item of filtered.items) {
      assert.equal(new URL(item.lot_url!).hostname.toLowerCase().replace(/^www\./, ''), site.value);
    }
  } finally {
    await pool.end();
  }
});
