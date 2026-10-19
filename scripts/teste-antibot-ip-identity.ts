import assert from 'node:assert/strict';
import { normalizeClientIp as canonical } from '../src/domain/security/client-ip.js';
import { normalizeClientIp as shim } from '../src/core/antibot/ip.js';

assert.equal(shim, canonical);
for (const ip of ['127.0.0.1', '[::ffff:192.0.2.1]', '2001:0db8::1']) {
  assert.equal(shim(ip), canonical(ip));
}
console.log('OK: antibot IP shim re-exports the canonical function reference');
