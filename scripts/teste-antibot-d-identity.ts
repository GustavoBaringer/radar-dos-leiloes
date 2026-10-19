import assert from 'node:assert/strict';
import { createWsProtection as canonical } from '../src/application/security/ws-protection.js';
import { createWsProtection as shim } from '../src/core/antibot/ws.js';
import { admitWsUpgrade as canonicalAdmission } from '../src/infra/websocket/ws-admission.js';
import { admitWsUpgrade as shimAdmission } from '../src/core/antibot/ws-admission.js';
assert.equal(shim, canonical);
assert.equal(shimAdmission, canonicalAdmission);
console.log('OK: WS protection/admission shims preserve function references');
