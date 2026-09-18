/**
 * A cidade do lote é a do PÁTIO DE RETIRADA, não a do pregão.
 *
 * Três asserções, e a terceira é a que me impediu de corromper a base: o pátio
 * só vale como fonte de cidade quando é ENDEREÇO. O leilo batiza o pátio com o
 * nome da capital mais próxima ("PÁTIO FORTALEZA-CE" fica em Eusébio), e ler
 * esse nome como cidade trocaria dado bom por dado errado em 434 lotes.
 */
import { spawnSync } from 'node:child_process';

const sql = (q) => spawnSync('docker',
  ['exec', 'leilao-db', 'psql', '-U', 'leilao', '-d', 'leilao', '-t', '-A', '-c', q],
  { encoding: 'utf8' }).stdout.trim();

let falhas = 0;
const ok = (n, d = '') => console.log(`  OK    ${n}${d ? ` — ${d}` : ''}`);
const falha = (n, d) => { falhas++; console.log(`  FALHA ${n} — ${d}`); };

/* 1 — nenhum lote da freitas com pátio /UF ficou sem cidade */
const semCidade = Number(sql(
  `select count(*) from lots where source_id='freitas' and yard ~ '/[A-Za-z]{2}$' and city is null`));
semCidade === 0
  ? ok('1. freitas: pátio com /UF sempre resolve a cidade', '0 sem cidade')
  : falha('1. freitas: pátio com /UF sempre resolve a cidade', `${semCidade} ainda sem cidade`);

/* 2 — a cidade bate com o PÁTIO, não com o pregão */
const divergentes = Number(sql(`
  select count(*) from lots
   where source_id='freitas' and yard ~ '/[A-Za-z]{2}$' and city is not null
     and upper(translate(city,'áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ','aaaaeeiooucAAAAEEIOOUC'))
         <> upper(translate(split_part(regexp_replace(yard, '.*\\s-\\s', ''), '/', 1),
                            'áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ','aaaaeeiooucAAAAEEIOOUC'))`));
divergentes === 0
  ? ok('2. a cidade é a do pátio, não a do pregão', '0 divergentes')
  : falha('2. a cidade é a do pátio, não a do pregão', `${divergentes} divergentes`);

/* 3 — O PORTÃO QUE IMPEDE A REGRESSÃO: nome de pátio não vira cidade.
      O leilo tem `city` correta e `yard` enganoso; se alguém "melhorar" o
      backfill lendo o nome do pátio, estas cidades somem. */
const casos = [
  ['leilo', 'Eusébio', 'FORTALEZA'],
  ['leilo', 'Aparecida de Goiânia', 'CENTRAL'],
];
for (const [fonte, cidadeCerta, nomeDoPatio] of casos) {
  const n = Number(sql(
    `select count(*) from lots where source_id='${fonte}' and city='${cidadeCerta}'`));
  const contaminados = Number(sql(
    `select count(*) from lots where source_id='${fonte}' and upper(city) like '%${nomeDoPatio}%'`));
  n > 0 && contaminados === 0
    ? ok(`3. ${fonte}: "${cidadeCerta}" preservada`, `${n} lotes, 0 com o nome do pátio`)
    : falha(`3. ${fonte}: "${cidadeCerta}" preservada`, `certos=${n} contaminados=${contaminados}`);
}

/* 4 — a regra de melhor grafia conta acento de verdade (era morta: length não muda) */
const escolhida = sql(`
  select (array_agg(c ORDER BY (c = upper(c)),
    (octet_length(c) - octet_length(translate(c,'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
                                               'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'))) DESC, c))[1]
  from (values ('Cuiaba'),('CUIABÁ'),('Cuiabá')) v(c)`);
escolhida === 'Cuiabá'
  ? ok('4. melhor grafia escolhe a acentuada', escolhida)
  : falha('4. melhor grafia escolhe a acentuada', `escolheu "${escolhida}"`);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
