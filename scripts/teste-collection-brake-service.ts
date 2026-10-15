import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { CollectionBrakeModule } from '../src/application/modules/collection-brake/collection-brake.module.js';
import { CollectionBrakeService } from '../src/application/services/collection/collection-brake.service.js';

const time = new Date();
const attempts: Record<string, { ok: boolean | null; startedAt: Date }[]> = {
  blocked: [{ ok: null, startedAt: time }, ...Array.from({ length: 5 }, (_, i) => ({ ok: false, startedAt: new Date(+time - (i + 1) * 1000) }))],
  healthy: [{ ok: true, startedAt: time }],
};
const checked: string[] = [];
const deps = {
  tentativasRecentes: async (id: string) => { checked.push(id); return attempts[id] ?? []; },
  fontesComHistorico: async () => ['blocked', 'healthy'],
};
const app = await NestFactory.createApplicationContext(CollectionBrakeModule.forRoot(deps), { logger: false });
try {
  const service = app.get(CollectionBrakeService);
  assert.equal(app.get(CollectionBrakeService), service);
  const verdict = await service.consultaFreio('blocked');
  assert.deepEqual({ permite: verdict.permite, seguidas: verdict.seguidas, motivo: verdict.motivo }, { permite: false, seguidas: 5, motivo: 'freado' });
  assert.deepEqual(await service.fontesFreadas(), [{ sourceId: 'blocked', seguidas: 5, proxima: new Date(+time - 1000 + 6 * 3_600_000) }]);
  assert.deepEqual(checked, ['blocked', 'blocked', 'healthy']);
  console.log('OK: brake Nest service DI; NULL ignored, 5 failures blocked, healthy filtered');
} finally { await app.close(); }
