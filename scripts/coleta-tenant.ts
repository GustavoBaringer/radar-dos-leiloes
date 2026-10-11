import { pool, query } from '../src/core/db.js';
import { getConnector } from '../src/connectors/index.js';
import { startRun, finishRun, upsertLots } from '../src/core/repo.js';
import { observerForCollection } from '../src/core/collection-observer.js';
import { executeCollection, type CollectionExecutionResult } from '../src/core/collection-execution.js';

// Uso: coleta-tenant <sourceId> <dominio> [limite] [timeout-ms]
const [sourceId, rawDomain, limitArg, timeoutArg] = process.argv.slice(2);
const positiveInteger = (value: string | undefined, fallback: number, name: string) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} deve ser inteiro positivo`);
  return parsed;
};
const idRange = (ids: number[]) => ids.length
  ? ids.reduce(([min, max], id) => [Math.min(min, id), Math.max(max, id)], [ids[0], ids[0]])
  : null;

let runId: number | undefined;
let startedAt: string | undefined;
try {
  if (!sourceId || !rawDomain) throw new Error('Uso: coleta-tenant <sourceId> <dominio> [limite] [timeout-ms]');
  const limit = positiveInteger(limitArg, 400, 'limite');
  const timeoutMs = positiveInteger(timeoutArg, 7_200_000, 'timeout-ms');
  const domain = new URL(`https://${rawDomain}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (domain !== rawDomain.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || !domain.includes('.')) {
    throw new Error('dominio inválido');
  }
  if (!getConnector(sourceId)) throw new Error(`fonte desconhecida: ${sourceId}`);
  if (!(await query('SELECT 1 FROM sources WHERE id = $1', [sourceId])).length) {
    throw new Error(`fonte não cadastrada no banco: ${sourceId}`);
  }

  const hostExpr = `CASE WHEN lower(lot_url) LIKE 'https://%' THEN substring(lot_url from 9) WHEN lower(lot_url) LIKE 'http://%' THEN substring(lot_url from 8) END`;
  const countLots = async () => {
    const [row] = await query<{ count: number; max_id: number | null }>(
      `WITH hosts AS (SELECT id, ${hostExpr} AS authority FROM lots), normalized AS (
         SELECT id, regexp_replace(regexp_replace(lower(split_part(split_part(split_part(authority, '/', 1), chr(63), 1), chr(35), 1)), '^www[.]', ''), ':[0-9]+$', '') AS host
         FROM hosts
       ) SELECT count(*)::int AS count, max(id)::int AS max_id FROM normalized
         WHERE host = $1 AND host ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?)([.]([a-z0-9]([a-z0-9-]*[a-z0-9])?)){1,}$'`,
      [domain],
    );
    return { count: Number(row.count), maxId: row.max_id == null ? null : Number(row.max_id) };
  };

  const before = await countLots();
  startedAt = new Date().toISOString();
  let newInsertIds: number[] = [];
  let result: CollectionExecutionResult;
  try {
    result = await executeCollection(
      { sourceId, tenant: domain, forceTenantObserver: true, limit, timeoutMs, job: 'collect:tenant', metadata: { origin: 'manual' } },
      {
        lookupConnector: getConnector,
        startRun: async (...args: Parameters<typeof startRun>) => { runId = await startRun(...args); return runId; },
        finishRun,
        upsertLots: async lots => {
          const outcome = await upsertLots(lots);
          newInsertIds = outcome.novos;
          return outcome;
        },
        observerForCollection,
        // Manual audit must not send user-facing push/email notifications.
        processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
        logError: (msg, error) => console.error(msg, error instanceof Error ? error.message : String(error)),
      },
    );
  } catch (error) {
    const after = await countLots();
    console.error(JSON.stringify({ source: sourceId, domain, runId: runId ?? null, startedAt, finishedAt: new Date().toISOString(), before, after, hostCountDelta: after.count - before.count, newInsertIds: newInsertIds.length, newInsertIdRange: idRange(newInsertIds), partial: after.count > before.count || newInsertIds.length > 0, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
    throw error;
  }
  const after = await countLots();
  console.log(JSON.stringify({
    source: sourceId, domain, runId, startedAt, finishedAt: new Date().toISOString(),
    httpStatus: result.result.httpStatus, fetched: result.result.fetched, mapped: result.result.lots.length,
    upserted: result.upserted, newInsertIds: newInsertIds.length,
    newInsertIdRange: idRange(newInsertIds),
    hostCountDelta: after.count - before.count,
    skipped: result.result.skipped, before, after, partial: result.result.note != null || result.publishErrors.length > 0,
    note: result.result.note ?? null, publishErrors: result.publishErrors,
  }));
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await pool.end();
}
