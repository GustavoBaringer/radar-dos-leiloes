/**
 * Reprocessa lotes já gravados com o normalizador atual.
 * Necessário porque scrub de placa, parser de modelo e classificação de tipo
 * rodam na ingestão: sem isto, lote coletado antes da correção fica defasado.
 */
import { pool, query } from '../src/core/db.js';
import { buildSearchText, parseTitle, scrubPlates, classifyAsset } from '../src/core/normalize.js';
import { isBidSuspect } from '../src/core/repo.js';

const rows = await query<any>(`
  SELECT id, source_id, title_raw, version, brand, model, city, state, seller_name, asset_type,
         current_bid, min_bid, appraisal, plate_masked, doc_type, source_category, raw, lot_url, photos
  FROM lots`);

let placas = 0;
let modelos = 0;
const porTipo = new Map<string, number>();

for (const r of rows) {
  const scrubbed = scrubPlates(r.title_raw);
  const version = r.version ? scrubPlates(r.version).text : null;

  // A categoria da fonte fica em lugares diferentes por conector; o backfill
  // reconstrói a partir do que já foi gravado em raw/doc_type.
  const sourceCategory =
    r.source_category ??
    (r.source_id === 'copart' ? r.raw?.vehicleType : null) ??
    (r.source_id === 'superbid' ? r.doc_type : null) ??
    null;

  const cls = classifyAsset(scrubbed.text, sourceCategory, r.raw?.grupoFonte ?? null);
  const assetType = r.asset_type ?? cls.assetType;
  // Ver superbid.ts: parser de veículo em título de imóvel inventa marca.
  const parsed =
    assetType === 'veiculo'
      ? parseTitle(scrubbed.text)
      : { brand: null, model: null, version: null, yearMake: null, yearModel: null };
  const brand = parsed.brand ?? (assetType === 'veiculo' ? r.brand : null);
  const searchText = buildSearchText([scrubbed.text, brand, parsed.model, version, r.city, r.state, r.seller_name]);

  if (scrubbed.plateMasked) placas++;
  if (parsed.model !== r.model) modelos++;
  const chave = assetType === 'veiculo' ? (cls.vehicleType ?? 'veiculo') : assetType;
  porTipo.set(chave, (porTipo.get(chave) ?? 0) + 1);

  await query(
    `UPDATE lots SET title_raw=$2, version=$3, brand=$4, model=$5, search_text=$6, plate_masked=$7,
            bid_suspect=$8, asset_type=$9, vehicle_type=$10, source_category=$11
     WHERE id=$1`,
    [
      r.id, scrubbed.text, version, brand, parsed.model, searchText,
      r.plate_masked ?? scrubbed.plateMasked,
      isBidSuspect(r.current_bid ?? r.min_bid, r.appraisal),
      assetType, assetType === 'veiculo' ? cls.vehicleType : null, sourceCategory,
    ],
  );
}

console.log(`lotes=${rows.length} placas_mascaradas=${placas} modelos_corrigidos=${modelos}`);
console.log('por tipo:', [...porTipo.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
await pool.end();
