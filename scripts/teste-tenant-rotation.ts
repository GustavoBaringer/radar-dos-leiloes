import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRotationSlot, rotateTenants } from '../src/connectors/tenant-rotation.js';

test('cron slots advance consecutively across the midnight gap', () => {
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour);
  assert.equal(collectRotationSlot(at(7, 13)), collectRotationSlot(at(7, 7)) + 1);
  assert.equal(collectRotationSlot(at(7, 18)), collectRotationSlot(at(7, 13)) + 1);
  assert.equal(collectRotationSlot(at(8, 7)), collectRotationSlot(at(7, 18)) + 1);
  assert.equal(collectRotationSlot(at(8, 0)), collectRotationSlot(at(7, 18)));
});

test('consecutive slots cover tenant pools without exceeding the limit', () => {
  for (const [size, limit] of [[89, 12], [26, 5], [96, 12], [98, 30], [27, 20], [9, 8], [66, 40]]) {
    const pool = Array.from({ length: size }, (_, i) => `tenant-${i}`);
    const visited = new Set<string>();
    for (let slot = 0; slot < Math.ceil(size / limit); slot++) {
      const date = new Date(2026, 9, 7 + Math.floor(slot / 3), [7, 13, 18][slot % 3]);
      const selected = rotateTenants(pool, limit, date);
      assert.ok(selected.length <= limit);
      selected.forEach((id) => visited.add(id));
    }
    assert.equal(visited.size, size);
  }
});

test('deduplicates stably, handles pool sizes, and rejects invalid limits', () => {
  const at = new Date(2026, 9, 7, 7);
  assert.deepEqual(rotateTenants(['a', 'a', 'b'], 5, at), ['a', 'b']);
  assert.deepEqual(rotateTenants([], 5, at), []);
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => rotateTenants(['a'], limit, at), RangeError);
  }
});
