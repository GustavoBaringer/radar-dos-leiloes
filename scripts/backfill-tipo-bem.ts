/**
 * Corrige o `asset_type` dos lotes que a própria categoria da fonte diz que são
 * imóveis e que ficaram gravados como `veiculo`.
 *
 * Causa (medido em 05/10/2026): o conector Superbid decidia pelo `productType`,
 * que é largo — 229 ofertas com `subCategory` "Terrenos Urbanos", "Apartamentos"
 * ou "Casas" vieram com productType de veículo e foram gravadas como veículo.
 * Eram elas que faziam a busca `?q=marea&assetType=veiculo` devolver 21 imóveis.
 * O conector já foi corrigido (classifica pela subcategoria); isto arruma o que
 * já está na base sem recoletar 8 mil lotes por uma requisição antibot.
 *
 * A assinatura é `asset_type='veiculo' AND vehicle_type IS NULL`: veículo sem
 * tipo de veículo é rótulo quebrado — `repo.upsertLots` só grava
 * `vehicle_type` quando o bem é veículo, e o classificador devolve `null` para
 * imóvel. Nenhum veículo de verdade fica assim (conferido lote a lote na
 * simulação), e a decisão final é refeita por `classifyAsset` com o título e a
 * categoria que já estão gravados.
 *
 * Sem argumento faz simulação e imprime o diff. Com --aplicar, grava.
 */
import { pool, query } from '../src/core/db.js';
import { classifyAsset, classifyProperty } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');

const linhas = await query<{
  id: number;
  source_id: string;
  source_category: string | null;
  title_raw: string;
  vehicle_type: string | null;
  property_type: string | null;
}>(
  `SELECT id, source_id, source_category, title_raw, vehicle_type, property_type
     FROM lots
    WHERE asset_type = 'veiculo' AND vehicle_type IS NULL
    ORDER BY source_id, id`,
);

const mudancas: Array<{ id: number; propertyType: string | null }> = [];
const porFonte = new Map<string, number>();
const porCategoria = new Map<string, number>();
const fora = new Map<string, number>();
const amostra: string[] = [];

for (const l of linhas) {
  const cls = classifyAsset(l.title_raw, l.source_category, null);
  if (cls.assetType !== 'imovel') {
    fora.set(`${l.source_id}/${cls.assetType}`, (fora.get(`${l.source_id}/${cls.assetType}`) ?? 0) + 1);
    continue;
  }
  mudancas.push({ id: l.id, propertyType: classifyProperty(l.title_raw, l.source_category) });
  porFonte.set(l.source_id, (porFonte.get(l.source_id) ?? 0) + 1);
  const cat = l.source_category ?? '(sem categoria)';
  porCategoria.set(cat, (porCategoria.get(cat) ?? 0) + 1);
  if (amostra.length < 12) {
    amostra.push(
      `  #${l.id} ${l.source_id} [${cat}] ${l.title_raw.slice(0, 74)}`,
    );
  }
}

console.log(amostra.join('\n'));
console.log('\npor fonte:');
for (const [f, n] of [...porFonte].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(18)} ${n}`);
console.log('por categoria:');
for (const [c, n] of [...porCategoria].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${c.padEnd(28)} ${n}`);
}
if (fora.size) {
  console.log('\nnão são imóvel, ficam como estão:');
  for (const [k, n] of [...fora].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
}
console.log(
  `\n${linhas.length} candidatos · ${mudancas.length} viram imóvel${aplicar ? '' : ' (simulação; use --aplicar)'}`,
);

if (aplicar) {
  const porTipo = new Map<string, number[]>();
  for (const m of mudancas) {
    const t = m.propertyType ?? 'imovel';
    if (!porTipo.has(t)) porTipo.set(t, []);
    porTipo.get(t)!.push(m.id);
  }
  for (const [tipo, ids] of porTipo) {
    await query(
      `UPDATE lots SET asset_type='imovel', property_type=$1, vehicle_type=NULL WHERE id = ANY($2)`,
      [tipo, ids],
    );
  }
  console.log('gravado');
}
await pool.end();