import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POLICIES, POLICY_IDS } from '../src/core/antibot/config.js';
import { ROUTE_POLICIES } from '../src/core/antibot/routes.js';
import { createResourcePool } from '../src/core/antibot/resources.js';

test('new image/ws/write policies have contract limits and identities', () => {
  assert.deepEqual(POLICY_IDS.slice(-5), ['image', 'imageMiss', 'wsIp', 'wsAccount', 'write']);
  assert.deepEqual(POLICIES.image, { id: 'image', identity: 'ip', max: 120, windowMs: 60_000 });
  assert.deepEqual(POLICIES.imageMiss, { id: 'imageMiss', identity: 'ip', max: 20, windowMs: 60_000 });
  assert.deepEqual(POLICIES.wsIp, { id: 'wsIp', identity: 'ip', max: 30, windowMs: 60_000 });
  assert.deepEqual(POLICIES.wsAccount, { id: 'wsAccount', identity: 'account', max: 10, windowMs: 60_000 });
  assert.deepEqual(POLICIES.write, { id: 'write', identity: 'account', max: 30, windowMs: 60_000 });
});

test('route policy aliases use one IP group for image/ws and shared GET/write groups', () => {
  for (const route of ['GET /api/img', 'HEAD /api/img']) assert.equal(ROUTE_POLICIES[route], 'image');
  assert.equal(ROUTE_POLICIES['GET /ws'], 'wsIp');
  for (const path of ['/api/home', '/api/home/leiloeiro', '/api/alerts', '/api/alerts/hits', '/api/favorites', '/api/push/key']) {
    assert.equal(ROUTE_POLICIES[`GET ${path}`], 'search');
    assert.equal(ROUTE_POLICIES[`HEAD ${path}`], 'search');
  }
  for (const route of [
    'POST /api/alerts', 'PATCH /api/alerts/:id', 'DELETE /api/alerts/:id',
    'POST /api/alerts/hits/seen', 'POST /api/favorites', 'DELETE /api/favorites/:lotId',
    'POST /api/push/subscribe',
  ]) assert.equal(ROUTE_POLICIES[route], 'write');
});

test('shared resource pool has no queue, bounded overrides, and idempotent release', () => {
  assert.throws(() => createResourcePool({ maxResources: 5 }), /maxResources/);
  assert.throws(() => createResourcePool({ maxImageJobs: 3 }), /maxImageJobs/);
  const pool = createResourcePool({ maxResources: 2, maxImageJobs: 1 });
  const a = pool.tryAcquireResource()!;
  const b = pool.tryAcquireResource()!;
  assert.equal(pool.tryAcquireResource(), null);
  a.release(); a.release();
  assert.ok(pool.tryAcquireResource());
  const image = pool.tryAcquireImageJob()!;
  assert.equal(pool.tryAcquireImageJob(), null);
  image.release();
});
