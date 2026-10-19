import assert from 'node:assert/strict';
import * as shim from '../src/core/antibot/challenge.js';
import * as service from '../src/application/security/challenge.js';
import { createChallengeHook } from '../src/infra/http/challenge-hook.js';
assert.equal(shim.loadChallengeConfig, service.loadChallengeConfig);
assert.equal(shim.createChallengeService, service.createChallengeService);
assert.equal(shim.createChallengeHook, createChallengeHook);
assert.equal(shim.CHALLENGE_ACTIONS, service.CHALLENGE_ACTIONS);
console.log('OK: challenge compatibility exports preserve references');
