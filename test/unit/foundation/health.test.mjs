import { describe, expect, it } from '@jest/globals';
import { HealthService } from '../../../dist/src/application/services/health/health.service.js';

describe('HealthService', () => {
  it('reports ok', () => {
    expect(new HealthService().check()).toEqual({ status: 'ok' });
  });
});
