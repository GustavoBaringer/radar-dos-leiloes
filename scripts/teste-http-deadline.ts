import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import test from 'node:test';
import { fetchText } from '../src/connectors/http.js';
import { CollectionCancellationError, withCollectionCancellation } from '../src/core/collection-cancellation.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function withServer(handler: RequestListener, run: (url: string, server: Server) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('total deadline aborts a trickling response body', async () => {
  const firstChunk = signal();
  const responseClosed = signal();
  await withServer((_req, res) => {
    res.writeHead(200);
    res.write('x');
    firstChunk.resolve();
    const timer = setInterval(() => res.write('x'), 30);
    res.on('close', () => { clearInterval(timer); responseClosed.resolve(); });
  }, async (url) => {
    const started = Date.now();
    const request = fetchText(url, { timeoutMs: 180, retries: 0, gapMs: 0 });
    await firstChunk.promise;
    await assert.rejects(request);
    await responseClosed.promise;
    assert(Date.now() - started < 1500, 'deadline should be bounded');
  });
});

test('caller aborts a pending body immediately without retrying', async () => {
  let requests = 0;
  const bodySent = signal();
  const responseClosed = signal();
  await withServer((_req, res) => {
    requests++;
    res.writeHead(200);
    res.write('pending');
    bodySent.resolve();
    res.on('close', responseClosed.resolve);
  }, async (url) => {
    const controller = new AbortController();
    const request = fetchText(url, { timeoutMs: 3000, retries: 3, gapMs: 0, signal: controller.signal });
    await bodySent.promise;
    controller.abort(new Error('caller stopped'));
    await assert.rejects(request, /caller stopped/);
    await responseClosed.promise;
    assert.equal(requests, 1);
  });
});

test('abort during retry backoff prevents another request', async () => {
  let requests = 0;
  const responseFinished = signal();
  await withServer((_req, res) => {
    requests++;
    res.writeHead(503);
    res.end('retry');
    res.on('finish', responseFinished.resolve);
  }, async (url) => {
    const controller = new AbortController();
    const request = fetchText(url, { timeoutMs: 1000, retries: 2, gapMs: 0, signal: controller.signal });
    await responseFinished.promise;
    controller.abort(new Error('stop backoff'));
    await assert.rejects(request, /stop backoff/);
    assert.equal(requests, 1);
  });
});

test('abort during per-host throttle prevents another request', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.end('ok');
  }, async (url) => {
    await fetchText(url, { retries: 0, gapMs: 500 });
    const controller = new AbortController();
    const request = fetchText(url, { retries: 2, gapMs: 500, signal: controller.signal });
    controller.abort(new Error('stop throttle'));
    await assert.rejects(request, /stop throttle/);
    assert.equal(requests, 1);
  });
});

test('normal response and transient retry continue to work', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    if (requests === 1) res.writeHead(503).end('retry');
    else res.writeHead(200).end('ok');
  }, async (url) => {
    const result = await fetchText(url, { timeoutMs: 1000, retries: 1, gapMs: 0 });
    assert.equal(result.status, 200);
    assert.equal(result.body, 'ok');
    assert.equal(requests, 2);
  });
});

test('collection signal aborts an active request without retrying', async () => {
  let requests = 0;
  const bodySent = signal();
  const responseClosed = signal();
  await withServer((_req, res) => {
    requests++;
    res.writeHead(200);
    res.write('pending');
    bodySent.resolve();
    res.on('close', responseClosed.resolve);
  }, async (url) => {
    const controller = new AbortController();
    const request = withCollectionCancellation({ signal: controller.signal }, () =>
      fetchText(url, { timeoutMs: 3000, retries: 3, gapMs: 0 }),
    );
    await bodySent.promise;
    controller.abort(new CollectionCancellationError('shutdown'));
    await assert.rejects(request, (err: any) => err instanceof CollectionCancellationError && err.kind === 'shutdown');
    await responseClosed.promise;
    assert.equal(requests, 1);
  });
});

test('collection deadline aborts the request with kind deadline', async () => {
  let requests = 0;
  const firstChunk = signal();
  await withServer((_req, res) => {
    requests++;
    res.writeHead(200);
    res.write('x');
    firstChunk.resolve();
    const timer = setInterval(() => res.write('x'), 30);
    res.on('close', () => clearInterval(timer));
  }, async (url) => {
    const started = Date.now();
    const request = withCollectionCancellation({ timeoutMs: 200 }, () =>
      fetchText(url, { timeoutMs: 30000, retries: 3, gapMs: 0 }),
    );
    await firstChunk.promise;
    await assert.rejects(request, (err: any) => err instanceof CollectionCancellationError && err.kind === 'deadline');
    assert(Date.now() - started < 2000, 'deadline should be bounded');
    assert.equal(requests, 1);
  });
});
