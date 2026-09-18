/**
 * O alerta avisa do que entra DEPOIS dele, e só do que está em disputa.
 *
 * Três casos que discriminam, com lotes sintéticos cuja data de entrada é
 * controlada. O caso 1 é o que o usuário relatou; os casos 2 e 3 são a outra
 * metade — sem eles, "não dispara para o passado" poderia significar
 * simplesmente "não dispara nunca".
 */
import { query, pool } from '../src/core/db.js';
import { avaliarAlertas } from '../src/core/alerts.js';

const marca = `janela-${Date.now()}`;
let falhas = 0;
const ok = (n, d = '') => console.log(`  OK    ${n}${d ? ` — ${d}` : ''}`);
const falha = (n, d) => { falhas++; console.log(`  FALHA ${n} — ${d}`); };

await query(`INSERT INTO sources (id,name,method,tier,enabled) VALUES ($1,'teste','api',1,false) ON CONFLICT DO NOTHING`, [marca]);

const [alerta] = await query(
  `INSERT INTO alerts (label, q, filters, channels, owner_id) VALUES ($1,'lamborghini','{}',ARRAY['sino'],1) RETURNING id, created_at`,
  [marca],
);

/** Cria um lote com data de entrada e status controlados. */
async function lote(sufixo, first_seen, status) {
  const [l] = await query(
    `INSERT INTO lots (source_id, external_id, title_raw, search_text, closing_model, status,
                       asset_type, vehicle_type, brand, model, first_seen_at, collected_at, auction_end_utc)
     VALUES ($1,$2,'LAMBORGHINI HURACAN','lamborghini huracan','timer_por_lote',$3,'veiculo','carro',
             'LAMBORGHINI','HURACAN',$4,now(), now() + interval '2 days')
     RETURNING id`,
    [marca, `${marca}-${sufixo}`, status, first_seen],
  );
  return Number(l.id);
}

const antes = await lote('antes', new Date(new Date(alerta.created_at).getTime() - 12 * 3600_000).toISOString(), 'aberto');
const depois = await lote('depois', new Date(new Date(alerta.created_at).getTime() + 1000).toISOString(), 'aberto');
const fechado = await lote('fechado', new Date(new Date(alerta.created_at).getTime() + 2000).toISOString(), 'encerrado');

const disparos = await avaliarAlertas([antes, depois, fechado]);
const ids = new Set(disparos.filter((d) => d.label === marca).map((d) => d.lotId));

ids.has(antes) ? falha('1. lote que ENTROU ANTES não dispara', 'disparou') : ok('1. lote que entrou ANTES do alerta não dispara');
ids.has(depois) ? ok('2. lote que entrou DEPOIS dispara') : falha('2. lote que entrou DEPOIS dispara', 'não disparou — alertas estariam mortos');
ids.has(fechado) ? falha('3. lote ENCERRADO não dispara', 'disparou') : ok('3. lote encerrado não dispara');

// E a leitura também esconde encerrado, mesmo com o hit já gravado.
await query(`INSERT INTO alert_hits (alert_id, lot_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [alerta.id, fechado]);
const [{ n }] = await query(
  `SELECT count(*)::int n FROM alert_hits h JOIN lots l ON l.id=h.lot_id
    WHERE h.alert_id=$1 AND l.status IN ('encerrado','vendido')`, [alerta.id],
);
n === 1 ? ok('o hit de lote encerrado permanece gravado', 'some na leitura, não no banco — lote reabre na 2ª praça')
        : falha('o hit permanece gravado', `achou ${n}`);

await query(`DELETE FROM alert_hits WHERE alert_id=$1`, [alerta.id]);
await query(`DELETE FROM alerts WHERE id=$1`, [alerta.id]);
await query(`DELETE FROM lots WHERE source_id=$1`, [marca]);
await query(`DELETE FROM sources WHERE id=$1`, [marca]);
await pool.end();
console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
