/**
 * A cidade é garimpada em texto livre — e o garimpo não inventa.
 *
 * Três fontes não publicavam cidade em campo próprio: leilaopro (472 lotes,
 * 100% do acervo), suaplataforma (83%) e suporte-leilões (51%). A informação
 * existe no nome do leilão, no título e no slug da URL.
 *
 * As asserções 3 e 4 são as que importam: um garimpo permissivo transforma
 * palavra portuguesa em sigla de estado e rótulo institucional em nome de
 * município — dois falsos positivos que o dry-run pegou antes de gravar.
 */
import { spawnSync } from 'node:child_process';
import { localDeTexto } from '../src/core/campos.js';

const sql = (q) => spawnSync('docker',
  ['exec', 'leilao-db', 'psql', '-U', 'leilao', '-d', 'leilao', '-t', '-A', '-c', q],
  { encoding: 'utf8' }).stdout.trim();
const n = (q) => Number(sql(q));

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => { falhas++; console.log(`  FALHA ${t} — ${d}`); };

/* 1 — a cobertura de cidade melhorou de fato */
const ativos = n(`select count(*) from lots where status <> 'encerrado'`);
const semCidade = n(`select count(*) from lots where status <> 'encerrado' and city is null`);
const pct = (100 * semCidade) / ativos;
pct < 9
  ? ok('1. cobertura de cidade', `${ativos - semCidade} de ${ativos} com cidade (${(100 - pct).toFixed(1)}%)`)
  : falha('1. cobertura de cidade', `${pct.toFixed(1)}% ainda sem cidade`);

/* 2 — o leilaopro, que nunca tinha cidade, passou a ter */
const leilaoproSem = n(`select count(*) from lots where source_id='leilaopro' and status<>'encerrado' and city is null`);
const leilaoproTot = n(`select count(*) from lots where source_id='leilaopro' and status<>'encerrado'`);
leilaoproSem < leilaoproTot
  ? ok('2. leilaopro deixou de ser 100% sem cidade', `${leilaoproTot - leilaoproSem} de ${leilaoproTot} agora têm`)
  : falha('2. leilaopro deixou de ser 100% sem cidade', `${leilaoproSem} de ${leilaoproTot} ainda sem`);

/* 3 — palavra portuguesa não vira sigla de estado.
      "o veículo encontra-se" chegou a virar a cidade "O veículo encontra"/SE. */
const armadilhas = [
  ['VEÍCULO VW GOL, o veículo encontra-se no pátio', 'encontra-se'],
  ['Imóvel desocupado, entrega-se livre', 'entrega-se'],
  ['/lote/leilao-fiat-doblo-2011-2012/338/', 'slug de veículo'],
];
for (const [texto, apelido] of armadilhas) {
  const r = localDeTexto(texto);
  r === null
    ? ok(`3. recusa "${apelido}"`)
    : falha(`3. recusa "${apelido}"`, `extraiu ${r.city}/${r.uf}`);
}

/* 4 — rótulo institucional não entra no nome do município */
const podas = [
  ['Um automóvel, Município de Pinhal Grande/RS', 'Pinhal Grande'],
  ['Terreno, Fórum de Presidente Getúlio/SC', 'Presidente Getúlio'],
  ['EXTRAJUDICIAL I ÁREA EM SANTA LUZIA/MG', 'Santa Luzia'],
  ['Casa em São José dos Pinhais/PR', 'São José dos Pinhais'],
];
for (const [texto, esperado] of podas) {
  const r = localDeTexto(texto);
  r?.city === esperado
    ? ok(`4. "${esperado}" sai limpo`)
    : falha(`4. "${esperado}" sai limpo`, `extraiu "${r?.city ?? 'nada'}"`);
}

/* 5 — cidade ambígua é recusada, não chutada */
const ambiguo = localDeTexto('UMA ÁREA EM NOVO HAMBURGO E CAMPO BOM/RS');
ambiguo === null
  ? ok('5. leilão de duas cidades fica sem cidade', 'não chuta uma delas')
  : falha('5. leilão de duas cidades fica sem cidade', `escolheu ${ambiguo.city}`);

/* 6 — nenhuma cidade gravada carrega rótulo institucional ou verbo */
const sujas = n(`select count(*) from lots
  where status <> 'encerrado'
    and (city ~* '^(munic[íi]pio|f[óo]rum|comarca|prefeitura|vara) ' or city ~* '(encontra|entrega|situad)')`);
sujas === 0 ? ok('6. nenhuma cidade gravada tem rótulo ou verbo')
            : falha('6. nenhuma cidade gravada tem rótulo ou verbo', `${sujas} lotes`);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
