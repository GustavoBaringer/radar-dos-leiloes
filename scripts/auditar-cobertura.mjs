#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

function hostOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = value.trim();
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch { return null; }
}

function hostMatches(domain, candidate) {
  const base = hostOf(domain), host = hostOf(candidate);
  return !!base && !!host && (host === base || host.endsWith(`.${base}`));
}

function classify(hasConnector, hasPlatform, lots) {
  if (lots.some(lot => lot.recent)) return 'recent_lot_url_evidence';
  if (!hasConnector && !hasPlatform) return 'no_connector_no_platform';
  if (!hasConnector) return 'no_connector_platform';
  return lots.length ? 'connector_stale' : 'connector_no_history';
}

function selfTest() {
  assert.equal(hostMatches('www.example.com', 'https://x.example.com/path'), true);
  assert.equal(hostMatches('example.com', 'https://notexample.com/path'), false);
  assert.equal(hostMatches('example.com', 'https://example.com.evil.test'), false);
  assert.equal(hostOf('not a URL ://'), null);
  assert.equal(classify(false, false, []), 'no_connector_no_platform');
  assert.equal(classify(false, true, []), 'no_connector_platform');
  assert.equal(classify(true, true, []), 'connector_no_history');
  assert.equal(classify(true, true, [{ recent: false }]), 'connector_stale');
  assert.equal(classify(true, true, [{ recent: true }]), 'recent_lot_url_evidence');
  // Connector-level success must not imply domain-level collection.
  assert.equal(classify(true, true, []), 'connector_no_history');
  console.log('Self-test passed');
}

async function audit() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  let parsed;
  try { parsed = new URL(connectionString); } catch { throw new Error('DATABASE_URL is invalid'); }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('DATABASE_URL must point to loopback');
  }
  const pool = new Pool({ connectionString, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [{ captured_at: capturedAt }] } = await client.query('SELECT now() AS captured_at');
    const cutoff = new Date(new Date(capturedAt).getTime() - 86400000);
    const { rows: domainRows } = await client.query(`
      SELECT DISTINCT a.domain, d.platform, d.connector_id, d.http_status,
             d.has_lots, d.checked_at
      FROM auctioneers a LEFT JOIN discovered_sites d ON d.domain = a.domain
      WHERE a.domain IS NOT NULL AND btrim(a.domain) <> ''`);
    const { rows: lots } = await client.query(`
      SELECT lot_url, max(collected_at) AS last_seen, count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('aberto','agendado'))::int AS active,
             bool_or(collected_at >= $1) AS recent
      FROM lots WHERE lot_url IS NOT NULL AND btrim(lot_url) <> '' GROUP BY lot_url`, [cutoff]);
    const { rows: runs } = await client.query(`
      SELECT source_id, count(*)::int AS total,
             count(*) FILTER (WHERE ok IS TRUE)::int AS successful,
             count(*) FILTER (WHERE ok IS FALSE)::int AS failed,
             count(*) FILTER (WHERE ok IS NULL)::int AS incomplete,
             max(started_at) AS newest_started_at
      FROM collection_runs WHERE started_at >= $1 GROUP BY source_id ORDER BY source_id`, [cutoff]);
    const domains = new Map();
    for (const row of domainRows) {
      const domain = hostOf(row.domain), key = domain ?? `unknown:${row.domain}`;
      if (!domains.has(key)) domains.set(key, { domain, raw_domains: [], sites: [] });
      const entry = domains.get(key);
      entry.raw_domains.push(row.domain);
      entry.sites.push({ platform: row.platform, connector_id: row.connector_id,
        http_status: row.http_status, has_lots: row.has_lots, checked_at: row.checked_at });
    }
    const lotHosts = lots.map(lot => ({ ...lot, host: hostOf(lot.lot_url) }));
    const perDomain = [...domains.values()].map(entry => {
      if (!entry.domain) return { ...entry, category: 'unknown_invalid_domain' };
      // ponytail: O(domains × URLs); aggregate by hostname if catalogue scale demands it.
      const matched = lotHosts.filter(lot => lot.host && hostMatches(entry.domain, lot.host));
      return { ...entry,
        category: classify(entry.sites.some(s => s.connector_id), entry.sites.some(s => s.platform), matched),
        matched_lot_urls: matched.length,
        lot_total: matched.reduce((sum, lot) => sum + lot.total, 0),
        active_lots: matched.reduce((sum, lot) => sum + lot.active, 0),
        last_seen: matched.reduce((latest, lot) =>
          !latest || new Date(lot.last_seen) > new Date(latest) ? lot.last_seen : latest, null),
        recent_lot_url_evidence: matched.some(lot => lot.recent) };
    });
    const counts = {}, platformsMissing = {};
    for (const domain of perDomain) {
      counts[domain.category] = (counts[domain.category] ?? 0) + 1;
      if (domain.category === 'recent_lot_url_evidence') continue;
      for (const platform of new Set(domain.sites.map(site => site.platform || 'unidentified'))) {
        platformsMissing[platform] = (platformsMissing[platform] ?? 0) + 1;
      }
    }
    assert.equal(Object.values(counts).reduce((a,b) => a+b, 0), perDomain.length);
    const summary = { captured_at: capturedAt, window_start: cutoff.toISOString(),
      raw_domain_count: domainRows.length, normalized_domain_count: perDomain.length,
      category_counts: counts, missing_platform_counts: platformsMissing,
      missing_with_active_lots: perDomain.filter(d => d.active_lots > 0 && !d.recent_lot_url_evidence).length,
      invalid_lot_urls: lotHosts.filter(lot => !lot.host).length };
    const output = { ...summary, runs_by_source_id_24h: runs,
      caveats: ['Connector runs do not prove an individual domain attempt.',
        'URL matching can miss centralized platform URLs; auctioneer identity is not nationally deduplicated.',
        'Discovery HTTP status/has_lots are historical observations, not current probes.'], domains: perDomain };
    await client.query('COMMIT');
    const dir = '/tmp/opencode/radar-coverage-audit';
    await mkdir(dir, { recursive: true });
    const path = `${dir}/${new Date(capturedAt).toISOString().replace(/[:.]/g, '-')}.json`;
    await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ...summary, file: path }));
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw new Error('Audit failed; database details were not printed');
  } finally { client?.release(); await pool.end(); }
}

if (process.argv.includes('--self-test')) selfTest();
else audit().catch(error => { console.error(error.message); process.exitCode = 1; });
