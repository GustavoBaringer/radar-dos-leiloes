import assert from 'node:assert/strict';
import test from 'node:test';
import { conectorDaPlataforma } from '../src/core/descoberta.js';

test('resolves the connector from the preserved platform or detected platform', () => {
  assert.equal(conectorDaPlataforma(null, 'html-agenda'), 'htmlagenda');
  assert.equal(conectorDaPlataforma('soleon', 'html-agenda'), 'soleon');
  assert.equal(conectorDaPlataforma('html-agenda', null), 'htmlagenda');
  assert.equal(conectorDaPlataforma('vip-leiloes', 'soleon'), null);
  assert.equal(conectorDaPlataforma(null, 'unknown-platform'), null);
  assert.equal(conectorDaPlataforma(null, null), null);
  assert.equal(conectorDaPlataforma(undefined, undefined), null);
});
