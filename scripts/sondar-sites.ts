/** Casca de linha de comando. Sem argumento sonda 150; `all` varre o catálogo inteiro. */
import { query } from '../src/infra/database/query.js';
import { createDiscoveryContext } from '../src/bootstrap/discovery-context.js';

const arg = process.argv[2];
const limite = arg === 'all'
  ? (await query<any>('SELECT count(*)::int AS n FROM discovered_sites'))[0].n
  : Number(arg ?? 150);

const context = await createDiscoveryContext();
try { console.log(await context.service.rodarDescoberta('sonda', limite)); }
finally { await context.close(); }
