import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageQueue } from '../app-busca/src/lib/image-queue.js';

test('image queue shares two slots and cancels pending navigation without losing capacity', () => {
  const queue = createImageQueue();
  const started: number[] = [], release: Array<() => void> = [];
  const cancel = [0, 1, 2, 3, 4].map(i => queue.enqueue(done => { started.push(i); release[i] = done; }));
  assert.deepEqual(started, [0, 1]);
  cancel[2]();
  release[0]();
  assert.deepEqual(started, [0, 1, 3]);
  release[0]();
  assert.deepEqual(started, [0, 1, 3]);
  cancel[1]();
  assert.deepEqual(started, [0, 1, 3, 4]);
  cancel.forEach(done => done());
  queue.enqueue(done => { started.push(5); done(); });
  assert.equal(started.at(-1), 5);
});
