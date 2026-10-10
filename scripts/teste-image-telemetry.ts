import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createImageTelemetry } from '../src/core/antibot/image-telemetry.js';
import { createImageMetricsLog } from '../src/core/antibot/image-metrics-log.js';

test('image metrics count minutes, cache, blocks, latency and client peaks without identifiers', () => {
  let now = Date.parse('2026-10-10T10:00:00Z');
  const emitted: unknown[] = [];
  const metrics = createImageTelemetry({ clock: () => now, emit: s => emitted.push(s) });
  for (let i = 0; i < 130; i++) {
    const started = metrics.start('private-client');
    now += 10;
    metrics.complete(started, 200, i % 2 ? 'hit' : 'miss');
  }
  const rejected = metrics.start('another-client');
  now += 500;
  metrics.complete(rejected, 503);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.peakRequestsPerMinute, 131);
  assert.equal(snapshot.peakRequestsPerClientPerMinute, 130);
  assert.equal(snapshot.total.cacheHitRatio, .5);
  assert.equal(snapshot.total.overloaded, 1);
  assert.equal(snapshot.total.durationMsMax, 500);
  assert.equal(snapshot.total.rateLimited, 0);
  now = Date.parse('2026-10-10T10:01:00Z');
  metrics.flush();
  assert.equal(emitted.length, 1);
  assert.equal(metrics.snapshot().currentMinute.requests, 0);
  assert.equal(JSON.stringify(emitted).includes('private-client'), false);
  assert.equal(snapshot.currentMinute.durationBuckets.lt50ms, 130);
});

test('image metrics bound client memory and tolerate a broken observer', () => {
  const metrics = createImageTelemetry({ maxClients: 1, emit: () => { throw Error('disk'); } });
  metrics.start('a'); metrics.start('b'); metrics.start('a');
  assert.equal(metrics.snapshot().currentMinute.clientsOmitted, 1);
  assert.equal(metrics.snapshot().peakRequestsPerClientPerMinute, 2);
  assert.doesNotThrow(() => metrics.flush(true));
});

test('daily image summaries survive a new writer and expire only metric files older than 90 days', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-image-metrics-'));
  try {
    await writeFile(join(dir, '2025-01-01.jsonl'), '{}\n');
    await writeFile(join(dir, 'keep.txt'), 'keep');
    const writer = createImageMetricsLog(dir);
    writer.write({ minuteUtc: '2026-10-10T10:00:00Z', requests: 130 });
    await writer.close();
    const next = createImageMetricsLog(dir);
    next.write({ minuteUtc: '2026-10-10T10:01:00Z', requests: 2 });
    await next.close();
    const saved = (await readFile(join(dir, '2026-10-10.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(saved.map(s => s.requests), [130, 2]);
    await assert.rejects(readFile(join(dir, '2025-01-01.jsonl')), { code: 'ENOENT' });
    assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
