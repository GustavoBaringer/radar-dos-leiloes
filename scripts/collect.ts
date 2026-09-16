import { pool } from '../src/core/db.js';
import { connectors, getConnector } from '../src/connectors/index.js';
import { upsertLots, startRun, finishRun, ensureSources } from '../src/core/repo.js';
import { processarAposColeta } from '../src/core/pos-coleta.js';
import { makeRedis, CHANNEL_UPDATES } from '../src/queue/queues.js';

const only = process.argv[2];
const limit = Number(process.argv[3] ?? 400);
const targets = only ? [getConnector(only)!].filter(Boolean) : connectors;

const pub = makeRedis();
await ensureSources();
for (const c of targets) {
  const t0 = Date.now();
  const runId = await startRun(c.def.id, 'collect:cli', limit);
  try {
    const res = await c.collect({ limit });
    const { upserted, bidChanges, novos } = await upsertLots(res.lots);
    // Mesmo caminho de aviso do worker: coleta pela linha de comando também
    // dispara alerta. Antes só o worker avisava, e quem coletava por aqui
    // gravava o lote em silêncio.
    const aviso = await processarAposColeta(novos, (payload) => pub.publish(CHANNEL_UPDATES, JSON.stringify(payload)));
    await finishRun(runId, { ok: true, fetched: res.fetched, upserted, skipped: res.skipped, httpStatus: res.httpStatus });
    console.log(
      `${c.def.id.padEnd(10)} http=${res.httpStatus} lidos=${res.fetched} mapeados=${res.lots.length} gravados=${upserted} descartados=${res.skipped} lances=${bidChanges.length}` +
        (aviso.disparos ? ` alertas=${aviso.disparos} push=${aviso.push} email=${aviso.emails}/${aviso.pendentesEmail}pend` : '') +
        ` ${(Date.now() - t0) / 1000}s`,
    );
  } catch (err: any) {
    await finishRun(runId, { ok: false, error: String(err?.message ?? err) });
    console.error(`${c.def.id.padEnd(10)} FALHOU: ${err?.message ?? err}`);
  }
}
await pub.quit();
await pool.end();
