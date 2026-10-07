import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = process.env.HOST_VARIANT === 'compiled';
const lifecyclePath = resolve(root, compiled ? 'dist/src/bootstrap/lifecycle.js' : 'src/bootstrap/lifecycle.ts');
const { createBootstrapLifecycle } = await import(pathToFileURL(lifecyclePath).href);

test('shutdown initiates TLS and HTTP close without waiting, destroys upgraded sockets, and is idempotent', async () => {
  const calls = [];
  let releaseTls;
  const tlsPending = new Promise((resolve) => { releaseTls = resolve; });
  let onSocketClose;
  const lifecycle = createBootstrapLifecycle();
  lifecycle.setTlsClose(() => { calls.push('tls-close'); return tlsPending; });
  lifecycle.trackSocket({
    destroy() { calls.push('socket-destroy'); },
    once(event, listener) { assert.equal(event, 'close'); onSocketClose = listener; },
  });
  lifecycle.setHttpClose(() => { calls.push('http-close'); });

  const first = lifecycle.close();
  const second = lifecycle.close();
  assert.strictEqual(second, first);
  await Promise.resolve();
  assert.deepEqual(calls, ['tls-close', 'socket-destroy', 'http-close']);
  onSocketClose();
  releaseTls();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['tls-close', 'socket-destroy', 'http-close']);
});

test('all cleanup owners are attempted and failures are reported together', async () => {
  const calls = [];
  const reported = [];
  const lifecycle = createBootstrapLifecycle((error) => reported.push(error));
  lifecycle.setTlsClose(() => { calls.push('tls-close'); throw new Error('tls close failed'); });
  lifecycle.trackSocket({ destroy() { calls.push('socket-destroy'); throw new Error('socket destroy failed'); }, once() {} });
  lifecycle.setHttpClose(() => { calls.push('http-close'); throw new Error('http close failed'); });

  await assert.rejects(lifecycle.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    lifecycle.reportCleanupFailure(error);
    return true;
  });
  assert.deepEqual(calls, ['tls-close', 'socket-destroy', 'http-close']);
  assert.equal(reported.length, 1);
  assert.ok(reported[0] instanceof AggregateError);
});

test('startup failure after host creation uses the same cleanup closure', async () => {
  let closes = 0;
  const lifecycle = createBootstrapLifecycle();
  lifecycle.setHttpClose(() => { closes++; });
  await assert.rejects(lifecycle.failStartup(new Error('fixture startup failure')), /fixture startup failure/);
  assert.equal(closes, 1);
});
