/** Casca de linha de comando. Sem argumento sonda 150; `all` varre o catálogo inteiro. */
import { pool, query } from '../src/core/db.js';
import { rodarDescoberta } from '../src/core/descoberta.js';

const arg = process.argv[2];
const limite = arg === 'all'
  ? (await query<any>('SELECT count(*)::int AS n FROM discovered_sites'))[0].n
  : Number(arg ?? 150);

const r = await rodarDescoberta('sonda', limite);
console.log(r);
await pool.end();
