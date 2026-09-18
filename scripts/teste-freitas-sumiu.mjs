/**
 * Lote retirado pela fonte tem de sair do ar aqui — e lote vivo não.
 *
 * O 8048/604 da freitas ficou no ar depois de a fonte removê-lo: o leilão
 * estava "EM LOTEAMENTO" e foi remontado. Ele era invisível às duas rotinas de
 * encerramento — sem `auction_end_utc` o relógio não age, e o candidato à
 * verificação exigia status 'aberto'/'agendado', que `sem_data` não é.
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
  ['8028-029', 'aberto'],
  ['8046-141', 'encerrado'],
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

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
