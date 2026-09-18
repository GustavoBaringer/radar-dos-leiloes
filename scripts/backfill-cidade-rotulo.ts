import * as campos from '../src/core/campos.js';
import { query } from '../src/core/db.js';
import { chaveCidade } from '../src/core/normalize.js';
const aplicar = process.argv.includes('--aplicar');
const alvos = await query(
  `SELECT id, city FROM lots
    WHERE city ~* '^(munic[íi]pio|f[óo]rum|comarca|prefeitura|vara) ' OR city ~* '(encontra|entrega|situad)'`,
);
const plano = alvos.map((l) => ({ id: l.id, de: l.city, para: campos.apararCidade(l.city) || null }));
for (const p of plano) console.log(`${String(p.id).padEnd(8)} ${JSON.stringify(p.de)} -> ${JSON.stringify(p.para)}`);
const mudam = plano.filter((p) => p.para && p.para !== p.de);
console.log(`\n${alvos.length} sujos, ${mudam.length} viram cidade limpa${aplicar ? '' : '  (simulação — use --aplicar)'}`);
if (aplicar && mudam.length) {
  await query(
    `UPDATE lots SET city=d.city, city_key=d.chave
       FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) city, unnest($3::text[]) chave) d
      WHERE lots.id=d.id`,
    [mudam.map((m) => m.id), mudam.map((m) => m.para), mudam.map((m) => chaveCidade(m.para))],
  );
  console.log('gravado');
}
process.exit(0);
