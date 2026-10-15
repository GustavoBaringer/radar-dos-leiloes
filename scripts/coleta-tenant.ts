import { createCollectionContext, type CollectionContext } from '../src/bootstrap/collection-context.js';
import { pool, query } from '../src/core/db.js';
import { getConnector } from '../src/connectors/index.js';
import { startRun, finishRun, upsertLots } from '../src/core/repo.js';
import { observerForCollection } from '../src/application/services/collection/collection-observer.js';
import { type CollectionExecutionResult } from '../src/application/services/collection/collection-execution.js';
import { classifyAsset, looksLikeCollectible } from '../src/core/normalize.js';
import { guardTenantLots, normalizeHost, normalizeLotUrl } from './coleta-tenant-audit.js';

// Uso: coleta-tenant <sourceId> <dominio> <limite> <timeout-ms>
const [sourceId, rawDomain, limitArg, timeoutArg] = process.argv.slice(2);
const positiveInteger = (value: string | undefined, name: string) => {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} deve ser inteiro positivo`);
  return parsed;
};
const idRange = (ids: number[]) => ids.length
  ? ids.reduce(([min, max], id) => [Math.min(min, id), Math.max(max, id)], [ids[0], ids[0]])
  : null;
const sampleSize = 20;

let context: CollectionContext | undefined;
let runId: number | undefined;
let startedAt: string | undefined;
let rejectedHostCount = 0;
let overLimitCount = 0;
let normalizeDiscardCount = 0;
try {
  if (!sourceId || !rawDomain) throw new Error('Uso: coleta-tenant <sourceId> <dominio> <limite> <timeout-ms>');
  const limit = positiveInteger(limitArg, 'limite');
  const timeoutMs = positiveInteger(timeoutArg, 'timeout-ms');
  const domain = normalizeHost(`https://${rawDomain}`)!;
  if (domain !== rawDomain.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || !domain.includes('.')) {
    throw new Error('dominio inválido');
  }
  if (!getConnector(sourceId)) throw new Error(`fonte desconhecida: ${sourceId}`);
  if (!(await query('SELECT 1 FROM sources WHERE id = $1', [sourceId])).length) {
    throw new Error(`fonte não cadastrada no banco: ${sourceId}`);
  }

  const hostExpr = `CASE WHEN lower(lot_url) LIKE 'https://%' THEN substring(lot_url from 9) WHEN lower(lot_url) LIKE 'http://%' THEN substring(lot_url from 8) END`;
  const snapshot = async () => query<{ id: number; lot_url: string | null; first_seen_at: string }>(
    `WITH hosts AS (SELECT id, lot_url, first_seen_at, ${hostExpr} AS authority FROM lots), normalized AS (
       SELECT id, lot_url, first_seen_at, regexp_replace(regexp_replace(lower(split_part(split_part(split_part(authority, '/', 1), chr(63), 1), chr(35), 1)), '^www[.]', ''), ':[0-9]+$', '') AS host FROM hosts
     ) SELECT id::int, lot_url, first_seen_at FROM normalized WHERE host = $1 ORDER BY id`, [domain],
  );

  const beforeRows = await snapshot();
  const before = { capturedAtUtc: new Date().toISOString(), count: beforeRows.length, ids: beforeRows.map(r => r.id), samples: beforeRows.slice(0, sampleSize).map(r => ({ id: r.id, url: normalizeLotUrl(r.lot_url), firstSeenUtc: new Date(r.first_seen_at).toISOString() })) };
  startedAt = new Date().toISOString();
  let newInsertIds: number[] = [];
  let result: CollectionExecutionResult;
  try {
    context = await createCollectionContext({ overrides:
      {
        lookupConnector: getConnector,
        startRun: async (...args: Parameters<typeof startRun>) => { runId = await startRun(...args); return runId; },
        finishRun,
        upsertLots: async (lots, control) => {
          const guarded = guardTenantLots(lots, domain, limit);
          rejectedHostCount = guarded.rejected.length;
          overLimitCount = guarded.overLimit;
          normalizeDiscardCount = guarded.accepted.filter(lot => {
            const raw = lot.raw as Record<string, unknown> | null | undefined;
            const textoEscopo = [lot.titleRaw, lot.sourceCategory, raw?.descricao, raw?.description, raw?.leilao, raw?.categoria].filter(Boolean).join(' ');
            return looksLikeCollectible(textoEscopo) || (lot.assetType ?? classifyAsset(lot.titleRaw, lot.sourceCategory, lot.sourceGroup).assetType) === 'outro';
          }).length;
          const outcome = await upsertLots(guarded.accepted, control);
          newInsertIds = outcome.novos;
          return outcome;
        },
        observerForCollection,
        // Manual audit must not send user-facing push/email notifications.
        processarAposColeta: async () => ({ disparos: 0, push: 0, emails: 0, pendentesEmail: 0 }),
        logError: (msg, error) => console.error(msg, error instanceof Error ? error.message : String(error)),
      }
    });
    result = await context.service.execute(
      { sourceId, tenant: domain, forceTenantObserver: true, limit, timeoutMs, job: 'collect:tenant', metadata: { origin: 'manual' } }
    );
  } catch (error) {
    const verification = await snapshot().then(rows => ({ rows, error: null as string | null }), error => ({ rows: null, error: error instanceof Error ? error.message : String(error) }));
    const afterRows = verification.rows;
    const afterIds = new Set(afterRows?.map(r => r.id) ?? []);
    const baselineIds = new Set(before.ids);
    const inserted = afterRows ? newInsertIds.filter(id => !baselineIds.has(id) && afterIds.has(id)) : null;
    const missing = afterRows ? newInsertIds.filter(id => baselineIds.has(id) || !afterIds.has(id)) : null;
    console.error(JSON.stringify({ source: sourceId, domain, runId: runId ?? null, startedAt, finishedAt: new Date().toISOString(), before, after: afterRows ? { capturedAtUtc: new Date().toISOString(), count: afterRows.length, ids: afterRows.map(r => r.id), samples: afterRows.slice(0, sampleSize).map(r => ({ id: r.id, url: normalizeLotUrl(r.lot_url), firstSeenUtc: new Date(r.first_seen_at).toISOString() })) } : null, hostCountDelta: afterRows ? afterRows.length - before.ids.length : null, newInsertIds: inserted, missingOrBaselineInsertIds: missing, newInsertIdRange: inserted ? idRange(inserted) : null, partial: true, persistenceError: error instanceof Error ? error.message : String(error), verificationError: verification.error, rejectedHostCount, normalizeDiscardCount, rejectedReasons: { hostMismatch: 'lotUrl ausente/inválida ou host diferente do solicitado', overLimit: 'itens além do limite explícito não persistidos', normalize: 'coleta normaliza para asset_type outro ou política global anti-colecionáveis' }, overLimitCount }));
    process.exitCode = 1;
    throw error;
  }
  const verify = await snapshot().then(rows => ({ rows, error: null as string | null }), error => ({ rows: null, error: error instanceof Error ? error.message : String(error) }));
  if (!verify.rows) throw new Error(`falha verificando persistência por host: ${verify.error}`);
  const afterRows = verify.rows;
  const afterIds = new Set(afterRows.map(r => r.id));
  const baselineIds = new Set(before.ids);
  const inserted = newInsertIds.filter(id => !baselineIds.has(id) && afterIds.has(id));
  const missing = newInsertIds.filter(id => baselineIds.has(id) || !afterIds.has(id));
  const updates = missing.length ? null : result.upserted - inserted.length;
  console.log(JSON.stringify({
    source: sourceId, domain, runId, startedAt, finishedAt: new Date().toISOString(),
    httpStatus: result.result.httpStatus, fetched: result.result.fetched, mapped: result.result.lots.length,
    upserted: result.upserted, newInsertIds: inserted, newInsertIdRange: idRange(inserted), insertedSamples: afterRows.filter(r => inserted.includes(r.id)).slice(0, sampleSize).map(r => ({ id: r.id, url: normalizeLotUrl(r.lot_url) })), updates,
    hostCountDelta: afterRows.length - before.ids.length,
    skipped: result.result.skipped + rejectedHostCount + normalizeDiscardCount + overLimitCount, rejectedHostCount, normalizeDiscardCount, rejectedReasons: { hostMismatch: 'lotUrl ausente/inválida ou host diferente do solicitado', overLimit: 'itens além do limite explícito não persistidos', normalize: 'coleta normaliza para asset_type outro ou política global anti-colecionáveis' }, overLimitCount, missingOrBaselineInsertIds: missing, before, after: { capturedAtUtc: new Date().toISOString(), count: afterRows.length, ids: afterRows.map(r => r.id), samples: afterRows.slice(0, sampleSize).map(r => ({ id: r.id, url: normalizeLotUrl(r.lot_url), firstSeenUtc: new Date(r.first_seen_at).toISOString() })) }, partial: missing.length > 0 || result.result.note != null || result.publishErrors.length > 0 || rejectedHostCount > 0 || overLimitCount > 0,
    note: result.result.note ?? null, publishErrors: result.publishErrors,
  }));
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  if (context) await context.close();
  else await pool.end();
}
