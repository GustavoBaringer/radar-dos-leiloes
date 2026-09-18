/**
 * Garimpa a cidade em texto livre para os lotes que ficaram sem ela.
 *
 * MEDIDO em 18/09: 2.614 lotes ativos sem cidade, concentrados em três fontes —
 * leilaopro (472, 100% do acervo dele: o conector nunca extraía cidade),
 * suaplataforma (1.225, 83%: lia só do título) e suporte-leilões (736, 51%).
 *
 * A informação existe, em lugares diferentes por fonte:
 *   leilaopro      -> nome do leilão ("LEILÃO IMÓVEL PRAIA MARISCAL, BOMBINHAS/SC")
 *   suporteleiloes -> título ("Vacaria/Rio Grande do Sul: Terreno…")
 *   suaplataforma  -> slug da URL ("/lote/apartamento-santo-andre-sp/")
 *
 * Por isso a regra é uma só (`campos.localDeTexto`) aplicada aos três campos, em
 * ordem de confiabilidade, e não quatro regras por conector para divergir.
 *
 * Sem argumento simula. Com --aplicar, grava.
 */
import { pool, query } from '../src/core/db.js';
import { chaveCidade } from '../src/core/normalize.js';
import * as campos from '../src/core/campos.js';

const aplicar = process.argv.includes('--aplicar');

type Linha = { id: number; source_id: string; title_raw: string; lot_url: string | null; raw: any };

const linhas = await query<Linha>(
  `SELECT id, source_id, title_raw, lot_url, raw FROM lots WHERE city IS NULL ORDER BY id`,
);

const mudancas: Array<{ l: Linha; city: string; uf: string; de: string }> = [];
for (const l of linhas) {
  // Ordem de confiança: o nome do leilão e o título são escritos por humano; o
  // slug da URL é derivado e pode trazer o tipo do bem colado.
  const fontes: Array<[string, string | null]> = [
    ['nome do leilão', l.raw?.leilao ?? null],
    ['título', l.title_raw],
    ['url', l.lot_url ? decodeURIComponent(l.lot_url) : null],
  ];
  for (const [de, texto] of fontes) {
    const achado = campos.localDeTexto(texto);
    if (achado) {
      mudancas.push({ l, ...achado, de });
      break;
    }
  }
}

const porFonte = new Map<string, number>();
for (const m of mudancas) porFonte.set(`${m.l.source_id} (via ${m.de})`, (porFonte.get(`${m.l.source_id} (via ${m.de})`) ?? 0) + 1);
console.log(`${linhas.length} lotes sem cidade | ${mudancas.length} recuperam (${(100 * mudancas.length / linhas.length).toFixed(1)}%)\n`);
for (const [k, n] of [...porFonte].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
console.log('\namostra:');
for (const m of mudancas.slice(0, 8)) console.log(`  [${m.l.source_id}] ${m.city}/${m.uf}  <- ${m.de}: "${String(m.de === 'url' ? m.l.lot_url : m.l.title_raw).slice(0, 52)}"`);

if (!aplicar) {
  console.log('\n(simulação — rode com --aplicar para gravar)');
  await pool.end();
  process.exit(0);
}
for (const m of mudancas) {
  await query(`UPDATE lots SET city=$1, state=$2, city_key=$3 WHERE id=$4`,
    [m.city, m.uf, chaveCidade(m.city), m.l.id]);
}
console.log(`\n${mudancas.length} lotes regravados.`);
await pool.end();
process.exit(0);
