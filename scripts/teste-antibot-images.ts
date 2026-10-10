import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import sharp from 'sharp';
import { createImageService } from '../src/core/antibot/images.js';
import type { ImageRequestOptions, ImageTransportResponse } from '../src/core/antibot/images.js';
import { createResourcePool } from '../src/core/antibot/resources.js';

const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#234567' } }).png().toBuffer();
const lease = () => {
  let releases = 0;
  return { value: { release: () => { releases++; } }, releases: () => releases };
};

function response(
  chunks: Uint8Array[],
  statusCode = 200,
  headers: ImageTransportResponse['headers'] = { 'content-type': 'image/png' },
  onDestroy?: () => void,
): ImageTransportResponse {
  const body = Readable.from(chunks) as Readable & { destroy: () => void };
  const destroy = body.destroy.bind(body);
  body.destroy = (() => { onDestroy?.(); destroy(); }) as typeof body.destroy;
  return { statusCode, headers, body };
}

function harness(overrides: Partial<Parameters<typeof createImageService>[0]> = {}) {
  const requests: { url: string; options: ImageRequestOptions }[] = [];
  let requestImpl = overrides.request ?? (async (url: string, options: ImageRequestOptions) => {
    requests.push({ url, options });
    return response([png]);
  });
  const resources = createResourcePool();
  const service = createImageService({
    safeHostChecker: (url) => url.hostname === 'images.example.test' || url.hostname === 'cdn.example.test',
    request: (url, options) => requestImpl(url, options),
    tryAcquireResource: resources.tryAcquireResource,
    tryAcquireImageJob: resources.tryAcquireImageJob,
    acquireDegradedWork: () => ({ release() {} }),
    ...overrides,
  });
  return {
    service, requests, setRequest: (fn: typeof requestImpl) => { requestImpl = fn; },
  };
}

test('image validates URL, credentials, port, all redirect hosts and loop/limit; destroys unused bodies', async () => {
  const h = harness();
  assert.deepEqual(await h.service.get(null), { kind: 'placeholder', reason: 'missing-url' });
  for (const url of [
    'http://images.example.test/a', 'https://user:pw@images.example.test/a',
    'https://images.example.test:444/a', 'https://not-allowed.example.test/a',
  ]) assert.equal((await h.service.get(url)).kind, 'placeholder');
  assert.equal(h.requests.length, 0);
  let destroyed = 0;
  h.setRequest(async () => response([], 302, { location: 'https://evil.example.test/image' }, () => destroyed++));
  assert.deepEqual(await h.service.get('https://images.example.test/a'), { kind: 'placeholder', reason: 'host-not-allowed' });
  assert.equal(destroyed, 1);

  const seenHosts: string[] = [];
  let call = 0;
  h.setRequest(async (url) => {
    seenHosts.push(new URL(url).hostname);
    call++;
    if (call === 1) return response([], 302, { location: '/b' });
    if (call === 2) return response([], 302, { location: '/a' });
    return response([png]);
  });
  assert.deepEqual(await h.service.get('https://images.example.test/a'), { kind: 'placeholder', reason: 'redirect-loop' });
  assert.deepEqual(seenHosts, ['images.example.test', 'images.example.test']);

  call = 0;
  h.setRequest(async (url) => {
    call++;
    return response([], 302, { location: `${new URL(url).pathname}next` });
  });
  assert.deepEqual(await h.service.get('https://images.example.test/start'), { kind: 'placeholder', reason: 'redirect-limit' });
  assert.equal(call, 4);
  await h.service.close();
});

test('raster magic, streaming caps, status and output bounds', async () => {
  const h = harness({ limits: { maxInputBytes: 128, maxOutputBytes: 8 } });
  let destroyed = 0;
  h.setRequest(async () => response([png], 200, { 'content-length': '129' }, () => destroyed++));
  assert.deepEqual(await h.service.get('https://images.example.test/large'), { kind: 'placeholder', reason: 'too-large' });
  assert.equal(destroyed, 1);
  h.setRequest(async () => response([Buffer.from('<svg><script>')], 200, { 'content-type': 'image/png' }));
  assert.deepEqual(await h.service.get('https://images.example.test/vector'), { kind: 'placeholder', reason: 'invalid-raster' });
  h.setRequest(async () => response([Buffer.alloc(129)], 200, {}));
  assert.deepEqual(await h.service.get('https://images.example.test/stream-limit'), { kind: 'placeholder', reason: 'too-large' });
  h.setRequest(async () => response([], 404));
  assert.deepEqual(await h.service.get('https://images.example.test/missing'), { kind: 'placeholder', reason: 'upstream-status' });

  const output = harness({ processImage: async () => ({ buffer: Buffer.alloc(9), contentType: 'image/webp' }), limits: { maxOutputBytes: 8 } });
  assert.deepEqual(await output.service.get('https://images.example.test/out'), { kind: 'placeholder', reason: 'too-large' });
  await h.service.close(); await output.service.close();
});

test('more than 120 distinct images can load in the same minute without a rate quota', async () => {
  const h = harness();
  for (let i = 0; i < 130; i++) {
    const result = await h.service.get(`https://images.example.test/image-${i}`);
    assert.equal(result.kind, 'image');
  }
  assert.equal(h.requests.length, 130);
  await h.service.close();
});

test('cache tracks TTL, replacement bytes, eviction and bypasses slots on hit', async () => {
  let now = 0;
  let requests = 0;
  const h = harness({
    clock: () => now,
    limits: { maxCacheEntries: 2, maxCacheBytes: 20, cacheTtlMs: 50 },
    request: async () => { requests++; return response([png]); },
    processImage: async () => ({ buffer: Buffer.alloc(8, requests), contentType: 'image/webp' }),
  });
  const url = 'https://images.example.test/a';
  assert.equal((await h.service.get(url, 200)).kind, 'image');
  const beforeHit = requests;
  assert.deepEqual((await h.service.get(url, 201)), { kind: 'image', buffer: Buffer.alloc(8, 1), contentType: 'image/webp', cache: 'hit' });
  assert.equal(requests, beforeHit);
  await h.service.get('https://images.example.test/b', 200);
  await h.service.get('https://images.example.test/c', 200);
  assert.equal((await h.service.get(url, 200)).kind, 'image');
  assert.equal(requests, 4, 'LRU eviction causes a fetch');
  now = 50;
  await h.service.get(url, 200);
  assert.equal(requests, 5, 'entry expires at exact TTL boundary');
  await h.service.close();
});

test('leases are no-queue and stay held until Sharp-like processor settles after abort', async () => {
  const pool = createResourcePool();
  const held: ReturnType<typeof lease>[] = [];
  let releaseProcessor!: () => void;
  let processorStarted!: () => void;
  const started = new Promise<void>((resolve) => { processorStarted = resolve; });
  const processing = new Promise<void>((resolve) => { releaseProcessor = resolve; });
  let active = 0;
  const h = harness({
    tryAcquireResource: () => {
      const l = lease(); held.push(l); active++;
      return { release: () => { l.value.release(); active--; } };
    },
    tryAcquireImageJob: pool.tryAcquireImageJob,
    processImage: async (input, contentType) => {
      processorStarted(); await processing; return { buffer: input, contentType };
    },
  });
  const abort = new AbortController();
  const work = h.service.get('https://images.example.test/slow', null, { signal: abort.signal });
  await started;
  abort.abort();
  assert.equal(active, 1, 'HTTP abort must not free the read lease while image processing continues');
  const extra = pool.tryAcquireImageJob();
  assert.ok(extra);
  assert.equal(pool.tryAcquireImageJob(), null, 'image slots have no queue');
  extra.release();
  releaseProcessor();
  assert.deepEqual(await work, { kind: 'source-failure', reason: 'client-aborted' });
  assert.equal(active, 0);
  assert.equal(held[0].releases(), 1);
  const first = pool.tryAcquireImageJob()!; first.release(); first.release();
  assert.ok(pool.tryAcquireImageJob());
  await h.service.close();
});

test('deadline abort destroys active stream and slots are released after completion', async () => {
  let destroyed = 0;
  const h = harness({
    limits: { deadlineMs: 5 },
    request: async (_url, opts) => new Promise<ImageTransportResponse>((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  assert.deepEqual(await h.service.get('https://images.example.test/timeout'), { kind: 'placeholder', reason: 'deadline' });
  assert.equal(destroyed, 0);
  await h.service.close();
});

test('client abort destroys a response body while streaming', async () => {
  let destroyed = 0;
  const body = new Readable({ read() {} }) as Readable & { destroy: () => void };
  const destroy = body.destroy.bind(body);
  body.destroy = (() => { destroyed++; destroy(); }) as typeof body.destroy;
  const h = harness({ request: async () => ({ statusCode: 200, headers: {}, body }) });
  const controller = new AbortController();
  const work = h.service.get('https://images.example.test/stream', null, { signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await work, { kind: 'source-failure', reason: 'client-aborted' });
  assert.ok(destroyed >= 1);
  await h.service.close();
});

test('real Sharp validates dimensions and decodes full-resolution images without resize', async () => {
  const tooLarge = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const h = harness({ request: async () => response([tooLarge]), limits: { maxPixels: 16 } });
  assert.deepEqual(await h.service.get('https://images.example.test/pixels'), { kind: 'placeholder', reason: 'invalid-dimensions' });
  const noResize = harness();
  const full = await noResize.service.get('https://images.example.test/full');
  assert.equal(full.kind, 'image');
  if (full.kind === 'image') assert.equal(full.contentType, 'image/png');
  await h.service.close(); await noResize.service.close();
});

test('resource pool defaults are bounded and release is idempotent', () => {
  const pool = createResourcePool();
  const leases = Array.from({ length: 4 }, () => pool.tryAcquireResource());
  assert.ok(leases.every(Boolean));
  assert.equal(pool.tryAcquireResource(), null);
  leases[0]!.release(); leases[0]!.release();
  assert.ok(pool.tryAcquireResource());
  const images = Array.from({ length: 2 }, () => pool.tryAcquireImageJob());
  assert.ok(images.every(Boolean));
  assert.equal(pool.tryAcquireImageJob(), null);
});
