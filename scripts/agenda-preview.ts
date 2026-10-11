/**
 * Prévia da agenda diária: mostra o que o worker AGENDARIA às 7h, 13h e 18h
 * sem tocar em Redis, no agendador BullMQ nem em coleta. Somente leitura.
 *
 *   node --env-file=.env --import tsx scripts/agenda-preview.ts
 *
 * Reproduz a mesma seleção de `src/queue/worker.ts` (`agendarTudo`), resolve a
 * população de tenants de cada conector e destaca os sites mapeados hoje.
 */
import { query, pool } from '../src/core/db.js';
import { connectors } from '../src/connectors/index.js';
import { workerDeployment, boundedCollection } from '../src/queue/deployment.js';

const DEPLOY = workerDeployment();

/** Conectores que leem a população de `discovered_sites` e o filtro exato. */
const POR_PLATAFORMA: Record<string, { plataforma: string; exigeLots: boolean }> = {
  htmlagenda: { plataforma: 'html-agenda', exigeLots: true },
  leilaopro: { plataforma: 'leilao-pro', exigeLots: true },
  leiloar: { plataforma: 'leiloar', exigeLots: true },
  leiloesbr: { plataforma: 'leiloesbr', exigeLots: true },
  leilotech: { plataforma: 'leilotech', exigeLots: false },
  leiloesvia: { plataforma: 'leiloesvia', exigeLots: true },
  sishp: { plataforma: 'sishp', exigeLots: true },
  soleon: { plataforma: 'soleon', exigeLots: true },
  suaplataforma: { plataforma: 'sua-plataforma', exigeLots: true },
  suporteleiloes: { plataforma: 'suporte-leiloes', exigeLots: true },
  vlance: { plataforma: 'vlance', exigeLots: true },
  bomvalor: { plataforma: 'bomvalor', exigeLots: false },
};

/** Tenants fixos no código: entram mesmo sem linha em `discovered_sites`. */
const TENANTS_FIXOS: Record<string, string[]> = {
  suporteleiloes: [
    'leiloespb.com.br', 'colossoleiloes.com.br', 'atlanticoleiloes.com.br',
    'marcotulioleiloes.com.br', 'vlleiloes.com.br', 'leiloesmonteiro.com.br',
    'maglianoleiloes.com.br',
  ],
  vipleiloes: ['ericosobral.com.br', 'lancecertoleiloes.com.br'],
  celsocunha: ['celsocunhaleiloes.com.br'],
};

/** Sites mapeados na investigação de 11/10/2026. */
const DE_HOJE = [
  'leiloespb.com.br', 'colossoleiloes.com.br', 'atlanticoleiloes.com.br',
  'marcotulioleiloes.com.br', 'vlleiloes.com.br', 'leiloesmonteiro.com.br',
  'maglianoleiloes.com.br', 'focoleiloes.com.br', 'ccjleiloes.com.br',
  'celsocunhaleiloes.com.br', 'compreipgfn.com.br', 'aplleiloes.com.br',
];

const enabled = connectors.filter((c) => !DEPLOY.sources || DEPLOY.sources.has(c.def.id));

console.log('=== AGENDA DIÁRIA (7h, 13h, 18h, tz %s) ===', DEPLOY.timezone);
console.log('fontes na agenda: %d de %d conectores', enabled.length, connectors.length);
if (DEPLOY.sources) console.log('WORKER_SOURCES restringe a: %s', [...DEPLOY.sources].join(', '));

const linhas: string[] = [];
for (const c of enabled) {
  const { limit } = boundedCollection(DEPLOY, c.def.id, c.def.method, DEPLOY.apiLimit);
  const alvo = POR_PLATAFORMA[c.def.id];
  const fixos = TENANTS_FIXOS[c.def.id] ?? [];
  let tenants: string[] = fixos;
  if (alvo) {
    const filtro = alvo.exigeLots ? 'AND has_lots IS NOT FALSE' : '';
    const rows = await query<{ domain: string }>(
      `SELECT domain FROM discovered_sites
        WHERE platform = $1 AND http_status = 200 ${filtro} ORDER BY domain`,
      [alvo.plataforma],
    );
    tenants = [...new Set([...rows.map((r) => r.domain), ...fixos])];
  }
  const marcado = tenants.filter((t) => DE_HOJE.includes(t));
  linhas.push(
    `${c.def.id.padEnd(22)} tier=${String(c.def.tier ?? '-').padEnd(3)} ` +
      `limite=${String(limit).padStart(5)} tenants=${String(tenants.length).padStart(4)}` +
      (alvo ? '' : ' [sem população de tenant]') +
      (marcado.length ? ` <- hoje: ${marcado.join(', ')}` : ''),
  );
}
console.log(linhas.join('\n'));

const tenantsPorFonte: Record<string, string[]> = {};
for (const l of linhas) {
  const id = l.slice(0, 22).trim();
  const m = /<- hoje: (.+)$/.exec(l);
  if (m) for (const t of m[1].split(', ')) (tenantsPorFonte[id] ??= []).push(t);
}

const naAgenda = new Set(Object.values(tenantsPorFonte).flat());
const presentes = DE_HOJE.filter((d) => naAgenda.has(d));
const ausentes = DE_HOJE.filter((d) => !naAgenda.has(d));
console.log('\n=== SITES MAPEADOS HOJE ===');
console.log('presentes na agenda: %d/%d', presentes.length, DE_HOJE.length);
if (ausentes.length) console.log('AUSENTES: %s', ausentes.join(', '));

const fontes = await query<{ id: string }>('SELECT id FROM sources ORDER BY id');
const cadastradas = new Set(fontes.map((f) => f.id));
const semFonte = enabled.filter((c) => !cadastradas.has(c.def.id));
console.log('\n=== SOURCES ===\ncadastradas: %d | conectores sem linha em sources: %d %s',
  cadastradas.size, semFonte.length, semFonte.length ? '(' + semFonte.map((c) => c.def.id).join(', ') + ')' : '');

await pool.end();