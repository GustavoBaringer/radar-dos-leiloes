// Audita a foto de 1 lote por fonte ATRAVÉS do proxy (o que o browser vê).
import { pool } from '../src/core/db.js';

type Row = { source_id: string; id: number; photos: string[] };
const { rows } = await pool.query<Row>(`select source_id, id, photos from lots where photo_count > 0 order by source_id, id`);

const amostra = new Map<string, Row[]>();
for (const r of rows) {
  const a = amostra.get(r.source_id) ?? [];
  if (a.length < 3 && r.photos?.[0]) a.push(r);
  amostra.set(r.source_id, a);
}
const contagem = new Map<string, number>();
for (const r of rows) contagem.set(r.source_id, (contagem.get(r.source_id) ?? 0) + 1);

async function testa(u: string): Promise<string> {
  try {
    const res = await fetch(`http://localhost:4500/api/img?u=${encodeURIComponent(u)}&w=800`, { signal: AbortSignal.timeout(25000) });
    const ct = res.headers.get('content-type') ?? '';
    await res.arrayBuffer();
    if (ct.startsWith('image/') && !ct.includes('svg')) return 'ok';
    return res.headers.get('x-nopic-motivo') ?? ct;
  } catch (e: any) {
    return 'ERR:' + String(e?.message ?? e).slice(0, 25);
  }
}

const tarefas: Promise<void>[] = [];
const res = new Map<string, string[]>();
for (const [f, a] of amostra) {
  tarefas.push((async () => {
    const out: string[] = [];
    for (const r of a) out.push(await testa(r.photos[0]));
    res.set(f, out);
  })());
}
await Promise.all(tarefas);

console.log('fonte'.padEnd(20), 'lotes'.padEnd(7), 'proxy(ate 3)');
for (const [f, s] of [...res.entries()].sort()) {
  console.log(f.padEnd(20), String(contagem.get(f)).padEnd(7), s.join(', '));
}
await pool.end();