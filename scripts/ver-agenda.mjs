/** Mostra os agendadores gravados no Redis — o payload REAL, que pode divergir do código. */
import { Queue } from 'bullmq';
const conn = { host: '127.0.0.1', port: 6380 };
for (const nome of ['collect', 'refresh', 'discover']) {
  const q = new Queue(nome, { connection: conn });
  const s = await q.getJobSchedulers(0, 50, true);
  console.log(`--- ${nome} (${s.length}) ---`);
  for (const j of s) console.log(' id=', j.key ?? j.id, '| name=', j.name, '| pattern=', j.pattern, '| template=', JSON.stringify(j.template?.data ?? null));
  await q.close();
}
process.exit(0);
