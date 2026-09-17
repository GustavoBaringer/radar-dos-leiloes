/**
 * Reclassifica o tipo de veículo da base já gravada.
 *
 * Por que não rodar classifyAsset em tudo: `sourceGroup` (a categoria de nível
 * acima do Superbid) não é persistido, então linhas que dependiam dele cairiam
 * no padrão "carro" e a correção criaria erro novo. Este script só toca linha
 * onde o próprio TÍTULO afirma o tipo, e as que a regra do ano ("2008") havia
 * transformado em SUV.
 *
 * Sem argumento faz simulação e imprime o diff. Com --aplicar, grava.
 */
import { query } from '../src/core/db.js';
import { classifyAsset, tipoForteDoTitulo, VEHICLE_TYPE_LABEL } from '../src/core/normalize.js';

const aplicar = process.argv.includes('--aplicar');
const ARMADILHA_ANO = /\b(2008|3008)\b/i;

type Linha = { id: number; source_id: string; title_raw: string; vehicle_type: string | null; source_category: string | null };

const linhas = await query<Linha>(
  `SELECT id, source_id, title_raw, vehicle_type, source_category
     FROM lots WHERE asset_type = 'veiculo' ORDER BY id`,
);

const mudancas: Array<Linha & { novo: string; motivo: string }> = [];
for (const l of linhas) {
  const forte = tipoForteDoTitulo(l.title_raw, l.source_category);
  if (forte && forte !== l.vehicle_type) {
    mudancas.push({ ...l, novo: forte, motivo: 'titulo' });
    continue;
  }
  const peloCategoria = l.source_category ? classifyAsset(l.title_raw, l.source_category).vehicleType : null;

  /**
   * Sobrou da regra do ano: era SUV só porque o título trazia "2008"/"3008".
   *
   * É limpeza HISTÓRICA — o classificador já não confunde o ano com o Peugeot
   * (a regra virou `peugeot[ /-]*[23]008`). Ela só desfaz o que a versão antiga
   * gravou.
   *
   * O guarda `peloCategoria !== 'suv'` é obrigatório: sem ele a regra rebaixava
   * SUV DE VERDADE — CR-V, Tucson, EcoSport e Pajero da Copart, cujo título
   * começa com o ANO do modelo ("2008 HONDA CR-V") numa categoria que diz
   * "SUV Pequenos". E entrava em pingue-pongue com a passada por categoria
   * abaixo: uma rebaixava, a outra promovia, a cada execução do script.
   */
  if (
    l.vehicle_type === 'suv' && ARMADILHA_ANO.test(l.title_raw) &&
    !/peugeot/i.test(l.title_raw) && !forte && peloCategoria !== 'suv'
  ) {
    mudancas.push({ ...l, novo: 'carro', motivo: 'ano' });
    continue;
  }

  /**
   * Correção que vem da CATEGORIA, não do título.
   *
   * Sem esta passada o backfill só enxergava metade das regras: 5 lotes de
   * leilo/"Pesados" ("MAGNUM 240", "PLATAFORMA 11LX50") continuavam `carro`
   * porque nenhuma palavra do título afirma o tipo — só a categoria afirma.
   *
   * O invariante que a torna segura: **só aceita mudança que SAI de `carro`**.
   * `sourceGroup` (a categoria de nível acima do Superbid) não é persistido,
   * então classifyAsset sem ele cai no padrão `carro` para as linhas que dele
   * dependiam. Aceitar apenas a saída torna estruturalmente impossível
   * reintroduzir esse erro — o pior caso vira não corrigir, nunca corromper.
   */
  if (l.vehicle_type === 'carro' && peloCategoria && peloCategoria !== 'carro') {
    mudancas.push({ ...l, novo: peloCategoria, motivo: 'categoria' });
  }
}

const porTransicao = new Map<string, number>();
for (const m of mudancas) {
  const k = `${m.vehicle_type ?? '—'} → ${m.novo}  (${m.motivo})`;
  porTransicao.set(k, (porTransicao.get(k) ?? 0) + 1);
}
console.log(`${linhas.length} veículos na base, ${mudancas.length} mudam\n`);
for (const [k, n] of [...porTransicao].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);

console.log('\namostra:');
for (const m of mudancas.slice(0, 12).concat(mudancas.slice(-8))) {
  console.log(`  [${m.source_id}] ${m.vehicle_type} → ${m.novo}  ${JSON.stringify(m.source_category)}  ${m.title_raw.slice(0, 64)}`);
}

if (!aplicar) {
  console.log('\n(simulação — rode com --aplicar para gravar)');
  process.exit(0);
}
for (const m of mudancas) await query(`UPDATE lots SET vehicle_type=$1 WHERE id=$2`, [m.novo, m.id]);
console.log(`\n${mudancas.length} lotes regravados.`);
process.exit(0);
