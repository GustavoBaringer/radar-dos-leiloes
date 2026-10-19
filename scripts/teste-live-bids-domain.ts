import assert from 'node:assert/strict';
import { bancoPeloDominio, fimDoVlance, intervaloMs, EXCECOES_VLANCE } from '../src/domain/lots/live-bids.js';

assert.equal(bancoPeloDominio('www.leiloesjudiciaismgnorte.com.br'), EXCECOES_VLANCE.leiloesjudiciaismgnorte);
assert.equal(bancoPeloDominio('www3.example.com'), 'example');
const base = Date.parse('2026-10-15T12:00:00Z');
assert.equal(fimDoVlance('2026-10-15 12:00:00', 1)?.toISOString(), '2026-10-15T16:00:00.000Z');
assert.equal(fimDoVlance('2026-10-15 12:00:00', -1)?.toISOString(), '2026-10-15T14:00:00.000Z');
assert.equal(fimDoVlance('15/10/2026 12:00:00', 0), null);
const wait = (ms: number) => intervaloMs(new Date(base + ms), base);
assert.equal(wait(60 * 60_000 + 1), null);
assert.equal(wait(60 * 60_000), 5 * 60_000);
assert.equal(wait(15 * 60_000), 60_000);
assert.equal(wait(5 * 60_000), 15_000);
assert.equal(wait(-3 * 60_000), 15_000);
assert.equal(wait(-3 * 60_000 - 1), null);
console.log('PASS: 11 domain assertions');
