import assert from 'node:assert/strict';
import { guardTenantLots, normalizeHost, normalizeLotUrl } from './coleta-tenant-audit.js';

assert.equal(normalizeHost('HTTPS://WWW.Example.com:443/a?q=1'), 'example.com');
assert.equal(normalizeHost('not a url'), null);
assert.equal(normalizeLotUrl('HTTPS://WWW.Example.com:443/a/?q=1#frag'), 'https://example.com/a?q=1');
assert.equal(normalizeLotUrl(null), null);
const a = { lotUrl: 'https://www.example.com/lote/1' }, b = { lotUrl: 'https://other.com/lote/2' }, c = { lotUrl: 'https://example.com/lote/3' };
assert.deepEqual(guardTenantLots([a, b, c], 'example.com', 2), { accepted: [a], rejected: [b], overLimit: 1 });
console.log('coleta-tenant audit: OK');
