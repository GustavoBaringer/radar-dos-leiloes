import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageQueue } from '../app-busca/src/lib/image-queue.js';

test('image queue no longer pairs requests: every ticket starts at once and cancelling is harmless', () => {
  const queue = createImageQueue();
  const started: number[] = [];
  const cancel = [0, 1, 2, 3, 4].map(i => queue.enqueue(done => { started.push(i); done(); }));
  assert.deepEqual(started, [0, 1, 2, 3, 4], 'no pending slot left behind');
  cancel.forEach(done => { done(); done(); });
  queue.enqueue(done => { started.push(5); done(); });
  assert.equal(started.at(-1), 5, 'cancelling a finished ticket does not block the next one');
});