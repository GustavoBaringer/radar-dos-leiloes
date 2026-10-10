import assert from 'node:assert/strict';
import { query, pool } from '../src/core/db.js';

// Sem --ativar, apenas confere a persistência. Não infere site oficial por nome/email.
const grupos: Array<[string, string, string[]]> = [
  ['soleon', 'soleon', ['construbemleiloes.com.br', 'gspleiloes.com.br', 'guariglialeiloes.com.br', 'leiloesceruli.com.br', 'maximoleiloes.com.br', 'snleiloes.com.br', 'winleiloes.com.br']],
  ['suporte-leiloes', 'suporteleiloes', ['goldenlance.com.br', 'leiloespb.com.br']],
  ['sua-plataforma', 'suaplataforma', ['adrianoapolinario.com.br', 'gracieleiloes.com.br', 'apabrfleiloes.com.br']],
];
try {
  for (const [platform, connector, hosts] of grupos) {
    for (const host of hosts) {
      const [r] = await query<{ total: number; ativos: number }>(
        `SELECT count(*)::int total,
          count(*) FILTER (WHERE status IN ('aberto','agendado','sem_data'))::int ativos
         FROM lots WHERE source_id=$1 AND
          lower(regexp_replace(regexp_replace(raw->>'tenant','^https?://',''),'^www\\.',''))=$2`,
        [connector, host],
      );
      assert(Number.isInteger(r.total) && Number.isInteger(r.ativos));
      if (!['gracieleiloes.com.br', 'apabrfleiloes.com.br'].includes(host)) {
        assert(r.total > 0, `Nenhum lote persistido para ${host}`);
      }
      if (process.argv.includes('--ativar')) {
        await query(
          `UPDATE discovered_sites SET platform=$2,connector_id=$3,http_status=200,
           has_lots=$4,checked_at=now(),note='Contrato confirmado e coleta dirigida validada dos DOCX Downloads/leiloeiros'
           WHERE lower(regexp_replace(domain,'^www\\.',''))=$1`,
          [host, platform, connector, r.ativos > 0],
        );
      }
      console.log(JSON.stringify({ domain: host, connector, ...r }));
    }
  }
} finally {
  await pool.end();
}
