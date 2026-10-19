import assert from 'node:assert/strict';
import { createLiveBidReaders } from '../src/infra/live-bids/live-bids.readers.js';
import type { LoteQuente } from '../src/domain/lots/live-bids.js';

const calls: string[] = [];
const readers = createLiveBidReaders({
  async fetchJson(url) {
    calls.push(url);
    if (url.includes('status/')) return { status: 200, data: { lote_id: 7, nome: 'PII', apelido: 'PII' } };
    if (url.includes('fusohorario')) return { status: 200, data: -1 };
    if (url.includes('/lance/')) return { status: 200, data: { a: { vl: '1.234,50', nome: 'PII', apelido: 'PII' } } };
    if (url.includes('dtfechamento')) return { status: 200, data: { dt_fechamento: '2026-10-15 12:00:00' } };
    return { status: 404, data: null };
  },
  async fetchText(url) { calls.push(url); return { status: 200, body: '<input id="hdMaiorLance" value="1.234,56">', headers: {} }; },
});
const lote: LoteQuente = { id: 1, sourceId: 'vlance', externalId: '7', lotUrl: 'https://example.test/lote', leilaoId: '9', currentBid: null, fim: new Date() };
assert.deepEqual(await readers.bomvalor(lote), null);
assert.deepEqual(await readers.freitas({ ...lote, lotUrl: '?leilaoId=9&loteNumero=7' }), { lance: 1234.56 });
const live = await readers.vlance(lote);
assert.equal(live?.lance, null); // valor não numérico; PII é descartada
assert.equal(JSON.stringify(live).includes('PII'), false);
const count = calls.length;
await readers.vlance(lote);
assert.equal(calls.length - count, 2); // cacheia banco/fuso; só relê lance e fechamento
console.log('PASS: 5 adapter assertions');
