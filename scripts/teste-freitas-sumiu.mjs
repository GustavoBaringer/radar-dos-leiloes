/**
 * Lote retirado pela fonte tem de sair do ar aqui — e lote vivo não.
 *
 * O 8048/604 da freitas ficou no ar depois de a fonte removê-lo: o leilão
 * estava "EM LOTEAMENTO" e foi remontado. Ele era invisível às duas rotinas de
 * encerramento — sem `auction_end_utc` o relógio não age, e o candidato à
 * verificação exigia status 'aberto'/'agendado', que `sem_data` não é.
 *
 * Segundo bug do mesmo gênero, achado pelo usuário em 22/09 (8064-345): um
 * lote 'sem_data' que a fonte CONTINUA listando toda varredura nunca fica
 * "ausente" — e a elegibilidade em verificarCandidatos() dependia disso.
 * Corrigido em encerramento.ts: sem_data com auction_start_utc velho também entra.
 *
 * Terceiro, mesmo dia (786098): "EM LOTEAMENTO" tinha o recuo de 6h de um
 * veredito estável — leilão inteiro renumerado, 37 lotes de link morto ao
 * mesmo tempo. Corrigido: esse veredito específico reconsulta em 1h.
 *
 * A asserção que importa é a 3: um verificador que fecha tudo passaria nas
 * outras duas sem verificar nada.
 */
import { spawnSync } from 'node:child_process';
import { VERIFICADORES } from '../src/core/verificacao.ts';

const sql = (q) =>
  spawnSync('docker', ['exec', 'leilao-db', 'psql', '-U', 'leilao', '-d', 'leilao', '-t', '-A', '-c', q], {
    encoding: 'utf8',
  }).stdout.trim();

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => {
  falhas++;
  console.log(`  FALHA ${t} — ${d}`);
};

/* 1 — a freitas tem verificador */
VERIFICADORES.freitas
  ? ok('1. freitas tem verificador')
  : falha('1. freitas tem verificador', `só existem: ${Object.keys(VERIFICADORES).join(', ')}`);

/* 2 — o lote reclamado está fechado, e pela fonte, não por palpite nosso */
const [status, razao, sinal] = (
  sql(`select status||'|'||coalesce(closed_reason,'-')||'|'||coalesce(verify_result,'-') from lots where id=114372`) || '||'
).split('|');
status === 'encerrado' && razao === 'verificado_na_fonte'
  ? ok('2. o lote removido na fonte está encerrado aqui', sinal)
  : falha('2. o lote removido na fonte está encerrado aqui', `status=${status} razao=${razao}`);

/* 3 — DISCRIMINA: removido some, aberto segue aberto, vendido fecha.
      Sem os três vereditos diferentes na mesma chamada, o teste não prova nada. */
const casos = [
  ['8048-604', 'sumiu'],
  // 8028-029 (fixture antiga) vendeu entre uma rodada e outra deste teste —
  // droga do teste com "casos reais": o lote muda de estado sob nossos pés.
  // 8064-307 fecha bem depois de hoje (22/09), então segue aberto por um tempo.
  ['8064-307', 'aberto'],
  ['8046-141', 'encerrado'],
  // 73709: "SEM LICITANTES" (recebeLance:false) não batia em nenhuma palavra
  // da lista e ficava indeterminado para sempre — 4 tentativas, mesmo veredito.
  ['8047-331', 'encerrado'],
];
const r = await VERIFICADORES.freitas.verificar(
  'www.freitasleiloeiro.com.br',
  casos.map(([ext], i) => ({ id: i, externalId: ext, lotUrl: null, categoria: null })),
);
const erradas = casos.filter(([, esperado], i) => r.get(i)?.veredito !== esperado);
erradas.length === 0
  ? ok('3. o verificador separa removido de vivo de vendido', casos.map(([e], i) => `${e}=${r.get(i)?.veredito}`).join(' '))
  : falha('3. o verificador separa removido de vivo de vendido', erradas.map(([e, x], i) => `${e}: esperado ${x}, veio ${r.get(casos.findIndex((c) => c[0] === e))?.veredito}`).join('; '));

/* 4 — nenhum lote de fonte com verificador fica preso sem data e sem prazo.
      12 restantes é fila normal (o ciclo tem teto); acima disso a rotina parou. */
const presos = Number(
  sql(`select count(*) from lots
        where status='sem_data' and source_id in ('freitas','soleon','vlance','leilo')
          and auction_end_utc is null
          and (verified_at is null or verified_at < now() - interval '7 days')`),
);
presos <= 60
  ? ok('4. não há fila de lote sem data e sem verificação', `${presos} aguardando`)
  : falha('4. não há fila de lote sem data e sem verificação', `${presos} lotes nunca verificados`);

/* 5 — 786058 (8064-345, "VENDA CONJUNTA") nunca ficava ausente da varredura
      porque a fonte continua listando: `collected_at < ult.u` nunca era
      verdadeiro e o lote nunca virava candidato. Achado pelo usuário em 22/09. */
const [status2, razao2] = (
  sql(`select status||'|'||coalesce(closed_reason,'-') from lots where id=786058`) || '|'
).split('|');
status2 === 'encerrado' && razao2 === 'verificado_na_fonte'
  ? ok('5. lote sempre presente na varredura (VENDA CONJUNTA) está encerrado')
  : falha('5. lote sempre presente na varredura (VENDA CONJUNTA) está encerrado', `status=${status2} razao=${razao2}`);

/* 6 — 786098: leilão 8069 renumerado (615 virou 318 no site). O veredito
      "EM LOTEAMENTO" tinha o mesmo recuo de 6h de um lote 'aberto' estável —
      37 lotes do mesmo leilão ficaram de link morto ao mesmo tempo por isso.
      Achado pelo usuário em 22/09. */
const [status3, razao3] = (
  sql(`select status||'|'||coalesce(closed_reason,'-') from lots where id=786098`) || '|'
).split('|');
status3 === 'encerrado' && razao3 === 'verificado_na_fonte'
  ? ok('6. lote de leilão renumerado (EM LOTEAMENTO) está encerrado')
  : falha('6. lote de leilão renumerado (EM LOTEAMENTO) está encerrado', `status=${status3} razao=${razao3}`);

/* 7 — nenhum lote com "EM LOTEAMENTO" fica preso além de 1h sem reconsulta —
      é o recuo curto que a asserção 6 depende de existir de verdade. */
const presosLoteamento = Number(
  sql(`select count(*) from lots
        where source_id='freitas' and verify_result='EM LOTEAMENTO'
          and status not in ('encerrado','vendido')
          and verified_at < now() - interval '2 hours'`),
);
presosLoteamento === 0
  ? ok('7. nenhum "EM LOTEAMENTO" preso além do recuo curto')
  : falha('7. nenhum "EM LOTEAMENTO" preso além do recuo curto', `${presosLoteamento} lotes`);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
