/**
 * Nome de pátio não é nome de cidade, e rótulo de interface não é endereço.
 *
 * Dois defeitos que produziam "cidades" inexistentes na faceta e no futuro mapa:
 *  - copart: "LEILÃO PÁTIO PORTO SEGURO - SP" virava a cidade "Leilão Pátio
 *    Porto Seguro" (e "Porto Seguro" ali é a seguradora, não o município da BA);
 *  - soleon: o pátio guardava a tela inteira do leiloeiro, e o regex pegava o
 *    PRIMEIRO "X - YY" — as maiúsculas de "AV" passavam por sigla de estado.
 */
import { spawnSync } from 'node:child_process';

const sql = (q) => spawnSync('docker',
  ['exec', 'leilao-db', 'psql', '-U', 'leilao', '-d', 'leilao', '-t', '-A', '-c', q],
  { encoding: 'utf8' }).stdout.trim();
const n = (q) => Number(sql(q));

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => { falhas++; console.log(`  FALHA ${t} — ${d}`); };

/* 1 — nenhuma cidade ativa é nome de pátio */
const fantasmas = n(`select count(*) from lots
  where status <> 'encerrado' and city ~* '^(p[áa]tio|leil[ãa]o|dep[óo]sito|garagem|estacionamento)'`);
fantasmas === 0 ? ok('1. nenhuma cidade ativa é nome de pátio')
                : falha('1. nenhuma cidade ativa é nome de pátio', `${fantasmas} lotes`);

/* 2 — a UF sobrevive quando a cidade é descartada.
      Descartar a cidade falsa não pode custar o estado: lote com só UF ainda
      filtra por região; lote sem nada some do mapa inteiro. */
const semUf = n(`select count(*) from lots
  where source_id='copart' and yard ~* '^leil' and status <> 'encerrado' and state is null`);
const comUf = n(`select count(*) from lots
  where source_id='copart' and yard ~* '^leil' and status <> 'encerrado' and state is not null`);
semUf === 0 && comUf > 0
  ? ok('2. a UF sobrevive ao descarte da cidade falsa', `${comUf} lotes com UF, 0 sem`)
  : falha('2. a UF sobrevive ao descarte da cidade falsa', `com=${comUf} sem=${semUf}`);

/* 3 — nenhum pátio ativo carrega rótulo de interface */
const sujos = n(`select count(*) from lots
  where status <> 'encerrado'
    and yard ~ 'Lance Inicial|Detalhes do Lote|Aguarde|Aberto para|Acompanhe ao Vivo'`);
sujos === 0 ? ok('3. nenhum pátio ativo tem rótulo de interface')
            : falha('3. nenhum pátio ativo tem rótulo de interface', `${sujos} lotes`);

/* 4 — O QUE DISCRIMINA: limpar o pátio não pode ter apagado a cidade dele.
      Um limpador guloso cortaria antes do "Cidade - UF" e deixaria o lote sem
      localização — trocaria um defeito visível por um invisível. */
const soleonAtivo = n(`select count(*) from lots where source_id='soleon' and status <> 'encerrado'`);
const soleonSemCidade = n(`select count(*) from lots
  where source_id='soleon' and status <> 'encerrado' and city is null`);
const pct = (100 * soleonSemCidade) / soleonAtivo;
pct < 20
  ? ok('4. limpar o pátio preservou a cidade', `${soleonSemCidade} de ${soleonAtivo} sem cidade (${pct.toFixed(1)}%)`)
  : falha('4. limpar o pátio preservou a cidade', `${soleonSemCidade} de ${soleonAtivo} sem cidade (${pct.toFixed(1)}%)`);

/* 5 — a contagem de pátios reflete pátios, não variações de texto */
const patios = n(`select count(distinct yard) from lots where source_id='soleon' and yard is not null`);
patios < 300
  ? ok('5. pátios distintos do soleon são pátios, não ruído', `${patios} (era 481 com a sujeira)`)
  : falha('5. pátios distintos do soleon', `${patios} — a sujeira ainda infla a contagem`);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
