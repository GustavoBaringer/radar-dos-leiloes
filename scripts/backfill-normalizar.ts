/**
 * Reaplica a normalização sobre o que já está gravado. A normalização roda na
 * ingestão, então lote antigo só mudaria por recoleta — e recoletar 21 mil
 * lotes para arrumar caixa de texto seria pagar caro por algo que dá para
 * recalcular do próprio banco: a entrada dos normalizadores são campos que já
 * estão lá.
 */
import { pool, query } from '../src/core/db.js';
import * as campos from '../src/core/campos.js';
import { chaveCidade } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');
type Linha = {
  id: number; title_raw: string; title_display: string | null; brand: string | null; model: string | null;
  version: string | null; year_make: number | null; year_model: number | null; km: number | null;
  color: string | null; fuel: string | null; doc_type: string | null; source_category: string | null;
  city: string | null; state: string | null; asset_type: string | null; property_type: string | null;
  lot_url: string | null; yard: string | null; seller_name: string | null; auctioneer_name: string | null;
  photos: any; raw: any;
};

const linhas = await query<Linha>(`SELECT id, title_raw, title_display, brand, model, version, year_make,
  year_model, km, color, fuel, doc_type, source_category, city, state, asset_type, property_type,
  lot_url, yard, seller_name, auctioneer_name, photos, raw FROM lots`);

/**
 * Melhor grafia por cidade, vinda do próprio índice. A Caixa publica sem acento
 * ("CUIABA") e o Superbid com ("Cuiabá"): sem este cruzamento, padronizar o
 * título trocaria o acento correto de uma fonte pelo texto sem acento da outra.
 */
const melhorGrafia = new Map<string, string>();
const acentos = (t: string) => t.length - t.normalize('NFD').replace(/\p{M}/gu, '').length;
for (const l of linhas) {
  const k = chaveCidade(l.city);
  const c = campos.caixaDeTitulo(l.city);
  if (!k || !c) continue;
  const atual = melhorGrafia.get(k);
  if (!atual || acentos(c) > acentos(atual)) melhorGrafia.set(k, c);
}

const conta = { titulo: 0, cor: 0, comb: 0, doc: 0, cidade: 0, foto: 0, url: 0 };
const updates: any[][] = [];

for (const l of linhas) {
  const city = melhorGrafia.get(chaveCidade(l.city) ?? '') ?? campos.caixaDeTitulo(l.city);
  const state = campos.uf(l.state);
  const color = campos.cor(l.color);
  const fuel = campos.combustivel(l.fuel);
  const docType = campos.docType(l.doc_type);
  const sourceCategory = campos.texto(l.source_category) ?? (l.doc_type && !docType ? campos.texto(l.doc_type) : null);
  const photos = campos.fotos(Array.isArray(l.photos) ? l.photos : []);
  const lotUrl = campos.url(l.lot_url);
  const area = Number(l.raw?.areaPrivativa ?? l.raw?.areaTotal ?? l.raw?.areaTerreno ?? NaN);
  const titleDisplay =
    l.asset_type === 'imovel'
      ? campos.tituloImovel({
          propertyType: l.property_type,
          area: Number.isFinite(area) ? area : null,
          city,
          state,
          neighborhood: campos.bairroDoTitulo(l.title_raw, city),
          titleRaw: l.title_raw,
        })
      : campos.tituloVeiculo({ brand: l.brand, model: l.model, version: l.version, yearMake: l.year_make, yearModel: l.year_model, titleRaw: l.title_raw });

  if (titleDisplay !== l.title_display) conta.titulo++;
  if (color !== l.color) conta.cor++;
  if (fuel !== l.fuel) conta.comb++;
  if (docType !== l.doc_type) conta.doc++;
  if (city !== l.city) conta.cidade++;
  if (photos.length !== (Array.isArray(l.photos) ? l.photos.length : 0)) conta.foto++;
  if (lotUrl !== l.lot_url) conta.url++;

  updates.push([l.id, titleDisplay, color, fuel, docType, sourceCategory, city, state,
    campos.km(l.km), campos.ano(l.year_make), campos.ano(l.year_model),
    campos.texto(l.yard), campos.texto(l.seller_name), campos.texto(l.auctioneer_name),
    lotUrl, JSON.stringify(photos), photos.length, chaveCidade(city)]);
}

console.log(`${linhas.length} lotes | título ${conta.titulo} · cor ${conta.cor} · combustível ${conta.comb}` +
  ` · documentação ${conta.doc} · cidade ${conta.cidade} · fotos ${conta.foto} · url ${conta.url}` +
  (aplicar ? '' : '  (simulação; use --aplicar)'));

if (aplicar) {
  const N = 500;
  for (let i = 0; i < updates.length; i += N) {
    const fatia = updates.slice(i, i + N);
    await query(
      `UPDATE lots SET title_display=u.td, color=u.cor, fuel=u.fuel, doc_type=u.doc,
              source_category=u.sc, city=u.city, state=u.uf, km=u.km, year_make=u.ym, year_model=u.yr,
              yard=u.yard, seller_name=u.sn, auctioneer_name=u.an, lot_url=u.url,
              photos=u.fotos::jsonb, photo_count=u.nfotos, city_key=u.ck
         FROM (SELECT * FROM unnest($1::int[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],
                     $7::text[],$8::text[],$9::int[],$10::int[],$11::int[],$12::text[],$13::text[],
                     $14::text[],$15::text[],$16::text[],$17::int[],$18::text[])
               AS t(id,td,cor,fuel,doc,sc,city,uf,km,ym,yr,yard,sn,an,url,fotos,nfotos,ck)) u
        WHERE lots.id = u.id`,
      Array.from({ length: 18 }, (_, c) => fatia.map((f) => f[c])),
    );
  }
  console.log('gravado');
}
await pool.end();
