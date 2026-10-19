import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const preload = new URL('./local-runtime.mjs', import.meta.url).pathname;

test('forces Nest and the public URL to the selected local loopback port', () => {
  const child = spawnSync(process.execPath, [
    '--import', preload,
    '--input-type=module',
    '-e', 'console.log(JSON.stringify({ host: process.env.BIND_HOST, nest: process.env.NEST_BOOTSTRAP, site: process.env.SITE_URL }))',
  ], {
    encoding: 'utf8',
    env: { ...process.env, BIND_HOST: '0.0.0.0', NEST_BOOTSTRAP: '0', SITE_URL: 'https://example.test', PORT: '45500' },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    host: '127.0.0.1',
    nest: '1',
    site: 'http://127.0.0.1:45500',
  });
});

test('rejects an invalid port before the application can start', () => {
  const child = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', 'process.exit(99)'], {
    encoding: 'utf8',
    env: { ...process.env, PORT: 'https://0.0.0.0:45500' },
  });

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid PORT/);
  assert.notEqual(child.status, 99);
});
