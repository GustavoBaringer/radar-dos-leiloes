import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { LiveBidsModule } from '../src/application/modules/live-bids/live-bids.module.js';
import { LiveBidsService } from '../src/application/services/live-bids/live-bids.service.js';

let now = 1_800_000_000_000;
const originalNow = Date.now;
const originalRandom = Math.random;
Date.now = () => now;
Math.random = () => 0;

try {
  let leitura: { lance: number } | null = null;
  let loteAtivo = true;
  const registros: unknown[] = [];
  const publicacoes: string[] = [];
  const dependencies = {
    lotesQuentes: async () => loteAtivo ? [{ id: 1, sourceId: 'fonte', externalId: 'x', lotUrl: null, leilaoId: null, currentBid: 100, fim: new Date(now + 5 * 60_000) }] : [],
    leitores: { fonte: async () => leitura },
    registrarLeituraAoVivo: async (id: number, lance: number | null) => { registros.push({ lotId: id, currentBid: lance }); return { lotId: id, currentBid: lance }; },
    publicar: async (payload: string) => { publicacoes.push(payload); },
    sleep: async () => {},
  };
  const app = await NestFactory.createApplicationContext(LiveBidsModule.forRoot(dependencies), { logger: false });
  try {
    const service = app.get(LiveBidsService);
    assert.equal(app.get(LiveBidsService), service);
    assert.equal(service.temLeitor('fonte'), true);
    assert.equal(service.temLeitor('desconhecida'), false);

    await service.ciclo();
    assert.equal(service.semCanal('fonte'), true);
    now += 60_000;
    leitura = { lance: 120 };
    await service.ciclo();
    assert.equal(service.semCanal('fonte'), false);
    assert.deepEqual(registros, [{ lotId: 1, currentBid: 120 }]);
    assert.deepEqual(publicacoes, [JSON.stringify({ type: 'bids', changes: [{ lotId: 1, currentBid: 120 }] })]);

    await service.ciclo();
    assert.equal(registros.length, 1);
    loteAtivo = false;
    await service.ciclo();
    assert.equal(service.semCanal('fonte'), false);
  } finally {
    await app.close();
  }
} finally {
  Date.now = originalNow;
  Math.random = originalRandom;
}
