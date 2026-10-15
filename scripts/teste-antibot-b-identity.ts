import assert from 'node:assert/strict';
import { createAntibot as canonicalEngine } from '../src/application/security/antibot-engine.js';
import { createAntibot as engineShim, createDefaultObserver as observerShim } from '../src/core/antibot/engine.js';
import { createDefaultObserver } from '../src/infra/observability/antibot-observer.js';
import { loadAntibotConfig as canonicalConfig } from '../src/infra/config/antibot-config.js';
import { loadAntibotConfig as configShim } from '../src/core/antibot/config.js';

assert.equal(engineShim, canonicalEngine);
assert.equal(configShim, canonicalConfig);
assert.equal(observerShim, createDefaultObserver);
console.log('OK: engine, config and observer shims preserve export references');
