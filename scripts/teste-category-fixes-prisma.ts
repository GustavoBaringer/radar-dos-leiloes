import assert from 'node:assert/strict';
import type { Prisma } from '../src/infra/database/generated/client.js';
import { fixAgriculturalCategories } from './fix-agricultural-categories.js';
import { fixMercedesCategories } from './fix-mercedes-categories.js';
import { fixVolvoCategories } from './fix-volvo-categories.js';

type Row = Record<string, any>;
function transactionFor(rows: Row[], failUpdate = false) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    async $queryRawUnsafe(sql: string, ...params: unknown[]) {
      calls.push({ sql, params });
      if (/^\s*SELECT\b/i.test(sql)) return rows;
      throw new Error('unexpected raw query');
    },
    async $executeRawUnsafe(sql: string, ...params: unknown[]) {
      calls.push({ sql, params });
      if (failUpdate) throw new Error('injected update failure');
      return 1;
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

const base = { id: 123, asset_type: 'veiculo', source_category: null, brand: null, model: null, version: null, city: 'Curitiba', state: 'PR', seller_name: null, lot_url: null };
const fixtures = [
  { run: fixAgriculturalCategories, row: { ...base, title_raw: 'Colheitadeira New Holland CR 9060 2015', vehicle_type: 'carro', source_id: 'fixture' } },
  { run: fixMercedesCategories, row: { ...base, title_raw: 'Mercedes-Benz Caminhão 1620', vehicle_type: 'carro', brand: 'MERCEDES-BENZ', model: 'GLA' } },
  { run: fixVolvoCategories, row: { ...base, title_raw: 'Volvo FH 460 Caminhão 6x4', vehicle_type: 'suv', brand: 'VOLVO' } },
];

for (const { run, row } of fixtures) {
  const dry = transactionFor([row]);
  const dryResult = await run(dry.tx, true);
  assert.ok('totalAtualizados' in dryResult ? dryResult.totalAtualizados : dryResult.totalModificados, 'fixture must exercise a changed classification');
  assert.equal(dry.calls.filter(c => /^\s*UPDATE\b/i.test(c.sql)).length, 0, 'dry-run must issue no UPDATE');

  const applied = transactionFor([row]);
  const appliedResult = await run(applied.tx, false);
  assert.ok('totalAtualizados' in appliedResult ? appliedResult.totalAtualizados : appliedResult.totalModificados);
  const update = applied.calls.find(c => /^\s*UPDATE\b/i.test(c.sql));
  assert.ok(update, 'apply mode must issue UPDATE');
  assert.match(update.sql, /WHERE id = \$/i);
  assert.ok(update.params.includes(row.id), 'UPDATE is bound to the selected lot id');

  const broken = transactionFor([row], true);
  await assert.rejects(run(broken.tx, false), /injected update failure/);
}

console.log('category fix Prisma transaction contracts: passed');
