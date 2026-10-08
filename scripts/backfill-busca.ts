/**
 * Recalcula o `search_text` de tudo que já está gravado.
 *
 * O texto de busca é montado na ingestão (`repo.upsertLots`), então lote antigo
 * só ganha a versão nova por recoleta — e recoletar 32 mil lotes custa uma
 * requisição contra antibot por fonte. As entradas do montador são campos que já
 * estão na tabela (`title_raw`, `brand`, `model`, `version`, `city`, `state`,
 * `seller_name`), então dá para refazer igual.
 *
 * Por que é preciso (medido em 05/10/2026): a cola de palavras vizinhas fabricava
 * palavra que não existe em nenhum anúncio — "com área" virava `comarea`, "em
 * área" virava `emarea` e "388 m² - Área" virava `marea`. Com `LIKE '%marea%'` a
 * busca de um carro devolvia 511 imóveis. A cola agora só acontece dentro de uma
 * palavra da fonte (é o que faz "T-CROSS" responder a "tcross").
 *
 * Sem argumento faz simulação e imprime o diff. Com --aplicar, grava.
 */
import { pool, query } from '../src/core/db.js';
import { buildSearchText } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');

const linhas = await query<{
  id: number;
  title_raw: string;
  brand: string | null;
  model: string | null;
  version: string | null;
  city: string | null;
  state: string | null;
  seller_name: string | null;
  search_text: string;
}>(
  `SELECT id, title_raw, brand, model, version, city, state, seller_name, search_text FROM lots`,
);

const mudancas: Array<{ id: number; novo: string }> = [];
let bytesAntes = 0;
let bytesDepois = 0;
const amostra: string[] = [];
for (const l of linhas) {
  const novo = buildSearchText([
    l.title_raw,
    l.brand,
    l.model,
    l.version,
    l.city,
    l.state,
    l.seller_name,
  ]);
  bytesAntes += l.search_text.length;
  bytesDepois += novo.length;
  if (novo === l.search_text) continue;
  mudancas.push({ id: l.id, novo });
  if (amostra.length < 5) {
    amostra.push(
      `  #${l.id} ${l.title_raw.slice(0, 58)}\n     antes : ${l.search_text.slice(0, 108)}\n     depois: ${novo.slice(0, 108)}`,
    );
  }
}

console.log(amostra.join('\n'));
console.log(
  `\n${linhas.length} lotes · ${mudancas.length} mudam (${((mudancas.length / Math.max(1, linhas.length)) * 100).toFixed(1)}%)` +
    ` · texto ${(bytesAntes / 1e6).toFixed(1)} MB -> ${(bytesDepois / 1e6).toFixed(1)} MB` +
    `${aplicar ? '' : ' (simulação; use --aplicar)'}`,
);

if (aplicar) {
  const PARTE = 4000;
  for (let i = 0; i < mudancas.length; i += PARTE) {
    const pedaco = mudancas.slice(i, i + PARTE);
    await query(
      `UPDATE lots AS l SET search_text = v.search_text
         FROM unnest($1::bigint[], $2::text[]) AS v(id, search_text)
        WHERE l.id = v.id`,
      [pedaco.map((m) => m.id), pedaco.map((m) => m.novo)],
    );
  }
  console.log('gravado');
}
await pool.end();