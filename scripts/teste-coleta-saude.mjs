/**
 * Saúde das coletas: o que está falhando e por quê.
 *
 * Existe porque um dia sem servidor esconde três coisas diferentes, e só a
 * medição separa: fonte bloqueando o nosso IP (nada a fazer em código), bug
 * nosso derrubando o lote inteiro de gravação, e simples ausência de execução.
 *
 * A asserção 3 é a que descobre problema NOVO: bloqueio conhecido é lista
 * fixa, e qualquer fonte fora dela falhando acende vermelho.
 */
import { spawnSync } from 'node:child_process';
import * as campos from '../src/core/campos.ts';

const sql = (q) =>
  spawnSync('docker', ['exec', 'leilao-db', 'psql', '-U', 'leilao', '-d', 'leilao', '-t', '-A', '-F', '|', '-c', q], {
    encoding: 'utf8',
  }).stdout.trim();

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => {
  falhas++;
  console.log(`  FALHA ${t} — ${d}`);
};

/** Fontes que bloqueiam o IP: não é defeito de código, é acesso negado na origem. */
const BLOQUEADAS = new Set(['caixa', 'superbid']);
/** Fonte aposentada: o vlance cobre o mesmo catálogo. */
const APOSENTADAS = new Set(['serrano']);

/* 1 — a porcentagem implausível não passa. Um lote com 5000% derrubava a
      gravação inteira do lote de suaplataforma (numeric(6,3) estoura em 1000). */
const casos = [
  [5, 5], [100, 100], [5000, null], [100.5, null], [0, null], [-3, null], [null, null],
];
const erradas = casos.filter(([entra, sai]) => campos.porcentagem(entra) !== sai);
erradas.length === 0
  ? ok('1. porcentagem implausível vira nulo', '5000% e 100,5% recusados; 5% e 100% mantidos')
  : falha('1. porcentagem implausível vira nulo', JSON.stringify(erradas));

/* 2 — e nenhum lote gravado carrega valor que estouraria a coluna */
const forade = Number(sql(`select count(*) from lots where fees_pct is not null and (fees_pct <= 0 or fees_pct > 100)`));
forade === 0
  ? ok('2. nenhuma comissão gravada fora de 0–100%')
  : falha('2. nenhuma comissão gravada fora de 0–100%', `${forade} lotes`);

/* 3 — fonte falhando que NÃO está na lista de bloqueio conhecido é novidade */
const linhas = sql(`
  select source_id, ok, coalesce(http_status::text,'-'), left(coalesce(error,'-'),60)
    from (select distinct on (source_id) source_id, ok, http_status, error, started_at
            from collection_runs where job in ('collect','collect:cli')
              and started_at > now() - interval '48 hours'
           order by source_id, started_at desc) u
   order by ok, source_id`)
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('|'));

const ruins = linhas.filter(([f, o]) => o === 'f' && !BLOQUEADAS.has(f) && !APOSENTADAS.has(f));
const bloqueadas = linhas.filter(([f, o]) => o === 'f' && BLOQUEADAS.has(f));
ruins.length === 0
  ? ok('3. nenhuma fonte nova falhando', `${linhas.filter((l) => l[1] === 't').length} fontes com última coleta ok`)
  : falha('3. nenhuma fonte nova falhando', ruins.map(([f, , s, e]) => `${f} (HTTP ${s}: ${e})`).join(' · '));

for (const [f, , s] of bloqueadas) console.log(`  nota  ${f} segue bloqueando o IP (HTTP ${s}) — acesso negado na origem, não é código`);

/* 4 — nenhuma fonte que PODE coletar ficou parada mais de 24h. As bloqueadas
      saem daqui de propósito: elas já aparecem como nota acima, e portão que
      fica vermelho para sempre por algo sem conserto deixa de ser lido. */
const paradas = sql(`
  select source_id, (now()-max(started_at))::interval(0)
    from collection_runs where job in ('collect','collect:cli') and ok
   group by 1 having now()-max(started_at) > interval '24 hours'`)
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('|'))
  .filter(([f]) => !APOSENTADAS.has(f) && !BLOQUEADAS.has(f));

paradas.length === 0
  ? ok('4. toda fonte que pode coletar coletou nas últimas 24h', `${BLOQUEADAS.size} bloqueadas fora da conta`)
  : falha('4. toda fonte que pode coletar coletou nas últimas 24h', paradas.map(([f, h]) => `${f} há ${h}`).join(' · '));

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
