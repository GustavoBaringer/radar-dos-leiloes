import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../src/core/db.js';
import { ensureSources } from '../src/core/repo.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(dir, file), 'utf8');
  await query(sql);
  console.log(`aplicado: ${file}`);
}
await ensureSources();
console.log('fontes registradas');
await pool.end();
