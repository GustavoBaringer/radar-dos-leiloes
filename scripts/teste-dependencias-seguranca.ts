import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import sharp from 'sharp';

const tempRoot = await mkdtemp(path.join('/tmp/opencode', 'dependency-security-'));
const staticRoot = path.join(tempRoot, 'static');
const webRoot = path.join(tempRoot, 'web');
const outsideRoot = path.join(tempRoot, 'outside');
const app = Fastify();

await Promise.all([
  mkdir(staticRoot, { recursive: true }),
  mkdir(webRoot, { recursive: true }),
  mkdir(outsideRoot, { recursive: true }),
]);
await Promise.all([
  writeFile(path.join(staticRoot, 'probe.txt'), 'static-ok'),
  writeFile(path.join(webRoot, 'app.js'), 'window.fixture = true;'),
  writeFile(path.join(outsideRoot, 'private.txt'), 'must-not-leak'),
]);

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/protected/') && request.headers.authorization !== 'Bearer fixture-token') {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});
app.get('/', async (_request, reply) => reply.type('text/html').send('<main>server-rendered fixture</main>'));
await app.register(fastifyStatic, {
  root: staticRoot,
  prefix: '/assets/',
  decorateReply: false,
  index: false,
  list: false,
});
await app.register(fastifyStatic, {
  root: webRoot,
  prefix: '/protected/',
  decorateReply: false,
  index: false,
  list: false,
});

test('Fastify SSR route and dual static roots work through inject', async () => {
  const ssr = await app.inject({ method: 'GET', url: '/' });
  assert.equal(ssr.statusCode, 200);
  assert.match(ssr.headers['content-type'] ?? '', /^text\/html/);
  assert.equal(ssr.body, '<main>server-rendered fixture</main>');

  const asset = await app.inject({ method: 'GET', url: '/assets/probe.txt' });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'] ?? '', /^text\/plain/);
  assert.equal(asset.body, 'static-ok');

  const directory = await app.inject({ method: 'GET', url: '/assets/' });
  assert.notEqual(directory.statusCode, 200);
  assert.doesNotMatch(directory.body, /probe\.txt/);
});

test('representative static auth guard and encoded traversal do not expose files', async () => {
  const denied = await app.inject({ method: 'GET', url: '/protected/app.js' });
  assert.equal(denied.statusCode, 401);
  const allowed = await app.inject({
    method: 'GET',
    url: '/protected/app.js',
    headers: { authorization: 'Bearer fixture-token' },
  });
  assert.equal(allowed.statusCode, 200);

  const traversal = await app.inject({
    method: 'GET',
    url: '/assets/%2e%2e/%2e%2e/outside/private.txt',
  });
  assert.notEqual(traversal.statusCode, 200);
  assert.doesNotMatch(traversal.body, /must-not-leak/);
  assert.ok(outsideRoot.startsWith(tempRoot));
});

test('sharp native pipeline reads a real PNG fixture and emits valid safe PNG output', async () => {
  const inputPath = path.join(tempRoot, 'fixture.png');
  const outputPath = path.join(tempRoot, 'rendered.png');
  const fixture = await sharp({
    create: { width: 5, height: 4, channels: 3, background: { r: 20, g: 80, b: 160 } },
  }).png().toBuffer();
  await writeFile(inputPath, fixture);

  const inputMetadata = await sharp(inputPath).metadata();
  assert.equal(inputMetadata.format, 'png');
  assert.equal(inputMetadata.width, 5);
  assert.equal(inputMetadata.height, 4);

  await sharp(inputPath).resize(3, 2).png().toFile(outputPath);
  const outputMetadata = await sharp(outputPath).metadata();
  assert.equal(outputMetadata.format, 'png');
  assert.equal(outputMetadata.width, 3);
  assert.equal(outputMetadata.height, 2);
  assert.equal(outputMetadata.exif, undefined);
});

test.after(async () => {
  await app.close();
  await rm(tempRoot, { recursive: true, force: true });
});
