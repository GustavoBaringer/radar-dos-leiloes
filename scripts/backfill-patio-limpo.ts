/**
 * Limpa o rótulo de interface grudado no pátio e re-extrai a cidade dele.
 *
 * O soleon recorta uma janela de 200 caracteres depois de "Local de Exposição",
 * e o texto do leiloeiro vem colado com a interface:
 * "…Capão Bonito - SP Aguarde Abertura Lance Inicial R$270,00 Detalhes do Lote".
 *
 * O conector já foi corrigido, mas lote que a coleta atual não devolve (encerrado,
 * fora da listagem) fica com o texto velho. MEDIDO depois da recoleta: 354 lotes
 * ATIVOS ainda sujos — esses aparecem na busca.
 *
 * A cidade é a colada numa UF VÁLIDA, e vale o ÚLTIMO par: o endereço termina em
 * cidade e UF, e o primeiro par pega "AV" como se fosse sigla de estado.
 *
 * Sem argumento simula. Com --aplicar, grava.
 */
import { pool, query } from '../src/core/db.js';
import { chaveCidade } from '../src/core/normalize.js';
import * as campos from '../src/core/campos.js';

const aplicar = process.argv.includes('--aplicar');
const CORTE_UI = /\s*(Aguarde|Aberto para|Encerrad|Lance Inicial|Maior Lance|Detalhes do Lote|Acompanhe ao Vivo)/i;

type Linha = { id: number; source_id: string; yard: string; city: string | null; state: string | null };

const linhas = await query<Linha>(
  `SELECT id, source_id, yard, city, state FROM lots
    WHERE yard IS NOT NULL AND yard ~ 'Lance Inicial|Detalhes do Lote|Aguarde|Aberto para|Acompanhe ao Vivo'`,
);

const mudancas: Array<{ l: Linha; yard: string; city: string | null; uf: string | null }> = [];
for (const l of linhas) {
  const limpo = l.yard.split(CORTE_UI)[0]?.trim() || null;
  if (!limpo) continue;
  const par = [...l.yard.matchAll(/([A-Za-zÀ-ú][A-Za-zÀ-ú\s.']{2,40}?)\s*[\/-]\s*([A-Z]{2})\b/g)]
    .filter((m) => campos.ehUf(m[2]))
    .pop();
  const city = par ? campos.caixaDeTitulo(par[1].trim()) : null;
  const uf = par ? par[2].toUpperCase() : null;
  // Só mexe quando há o que melhorar: pátio encurtado OU cidade que estava
  // ausente/errada. Nunca apaga cidade que já existe sem ter substituta.
  const melhoraPatio = limpo !== l.yard;
  const melhoraCidade = Boolean(city) && chaveCidade(city) !== chaveCidade(l.city);
  if (!melhoraPatio && !melhoraCidade) continue;
  mudancas.push({ l, yard: limpo, city: city ?? l.city, uf: uf ?? l.state });
}

const porCaso = new Map<string, number>();
for (const m of mudancas) {
  const k = `${m.l.source_id}: ${m.l.city ?? '(nula)'} -> ${m.city ?? '(nula)'}`;
  porCaso.set(k, (porCaso.get(k) ?? 0) + 1);
}
console.log(`${linhas.length} lotes com rótulo de UI no pátio | ${mudancas.length} mudam\n`);
for (const [k, n] of [...porCaso].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${String(n).padStart(5)}  ${k}`);

if (!aplicar) {
  console.log('\n(simulação — rode com --aplicar para gravar)');
  await pool.end();
  process.exit(0);
}
for (const m of mudancas) {
  await query(`UPDATE lots SET yard=$1, city=$2, state=$3, city_key=$4 WHERE id=$5`,
    [m.yard, m.city, m.uf, chaveCidade(m.city), m.l.id]);
}
console.log(`\n${mudancas.length} lotes regravados.`);
await pool.end();
process.exit(0);
