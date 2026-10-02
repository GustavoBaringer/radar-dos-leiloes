/**
 * Conserta link e chave externa dos lotes Kuss gravados com o número do lote.
 *
 * O raw antigo não guardou o id do lote no site (le_id), então ele é achado de
 * novo na listagem (loteado=N) e casado pela foto, só quando ela é única dos dois
 * lados: lote sem foto própria usa uma imagem genérica repetida. Mexer na linha
 * existente preserva o id interno (favoritos, alertas, links /lote/...). A linha
 * antiga sem par é encerrada, não apagada: a coleta já cria a correta.
 * Simula por padrão; --aplicar grava.
 */
import { pool, query } from '../src/core/db.js';

const BASE = 'https://www.claudiokussleiloes.com.br';
const aplicar = process.argv.includes('--aplicar');

async function edital(leilao: string, op: 'Q' | 'P', pag: number): Promise<any> {
  const r = await fetch(`${BASE}/json_edital.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `leilaoID=${leilao}&op=${op}&pag=${pag}&loteado=N&pesq=`,
  });
  return r.json();
}

const linhas = await query<{ id: number; external_id: string; leilao: string; foto: string | null }>(
  `SELECT id, external_id, raw->>'leilaoId' AS leilao, photos->>0 AS foto FROM lots WHERE source_id = 'kuss'`,
);

const porFoto = new Map<string, string[]>();
for (const leilao of new Set(linhas.map((l) => l.leilao).filter(Boolean))) {
  const paginas = Number((await edital(leilao, 'Q', 1))?.qtdePag ?? 0);
  for (let p = 1; p <= paginas; p++) {
    for (const it of (await edital(leilao, 'P', p)) ?? []) {
      if (!it.foto) continue;
      const k = `${leilao}|${it.foto}`;
      porFoto.set(k, [...(porFoto.get(k) ?? []), String(it.seq)]);
    }
    await new Promise((r) => setTimeout(r, 900));
  }
}

const fotoNoBanco = new Map<string, number>();
for (const l of linhas) if (l.foto) fotoNoBanco.set(`${l.leilao}|${l.foto}`, (fotoNoBanco.get(`${l.leilao}|${l.foto}`) ?? 0) + 1);

const usados = new Set(linhas.map((l) => l.external_id));
let ok = 0;
const semPar: Array<{ id: number; motivo: string }> = [];
for (const l of linhas) {
  if (/^\d+-\d{6,}$/.test(l.external_id)) continue; // já no formato leilão-le_id
  const k = `${l.leilao}|${l.foto}`;
  const candidatos = l.foto ? porFoto.get(k) ?? [] : [];
  const leId = candidatos.length === 1 && fotoNoBanco.get(k) === 1 ? candidatos[0] : undefined;
  if (!leId) { semPar.push({ id: l.id, motivo: `${l.external_id}: foto ${candidatos.length ? 'repetida' : 'fora da listagem'}` }); continue; }
  const externo = `${l.leilao}-${leId}`;
  if (usados.has(externo)) { semPar.push({ id: l.id, motivo: `${l.external_id}: ${externo} já existe` }); continue; }
  ok++;
  if (aplicar) {
    await query(
      `UPDATE lots SET external_id = $1, lot_url = $2, raw = raw || jsonb_build_object('leId', $3::text) WHERE id = $4`,
      [externo, `${BASE}/lance/${l.leilao}/0/${leId}`, leId, l.id],
    );
    usados.add(externo);
  }
}
if (aplicar) {
  for (const s of semPar) {
    await query(`UPDATE lots SET status = 'encerrado', closed_reason = 'link_kuss_por_numero_do_lote', closed_at = now() WHERE id = $1`, [s.id]);
  }
}
console.log(`${linhas.length} lotes Kuss; ${ok} reparados pela foto; ${semPar.length} antigos sem par${aplicar ? ' encerrados' : ''}${aplicar ? '' : ' (simulação: --aplicar grava)'}`);
if (semPar.length) console.log('sem par:', semPar.slice(0, 8).map((s) => `${s.id} (${s.motivo})`).join(', '));
await pool.end();
process.exit(0);
