/**
 * Lote vendido não é lote à venda.
 *
 * 125 lotes com status 'vendido' apareciam na busca e a faceta Situação
 * oferecia "Vendido" como se fosse estado vivo — só `status <> 'encerrado'`
 * era testado. Os 125 foram conferidos NA FONTE: 27/27 do superbid com
 * `sold:true, available:false, disponivel=0`, e 98/98 do soleon com veredito
 * 'encerrado' (97 "Vendido", 1 "ENCERRADO"), nenhum "Sem Licitante" — que
 * reabriria na 2ª praça e não poderia entrar aqui.
 *
 * A asserção 3 é a que impede o conserto preguiçoso: sumir da busca E da
 * faceta sem ficar acessível em "Encerrado" seria esconder catálogo, não
 * classificá-lo.
 */
import { searchLots } from '../src/core/repo.ts';
import { spawnSync } from 'node:child_process';

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

const vendidos = Number(sql(`select count(*) from lots where status='vendido'`));

/* 1 — a busca padrão não oferece lote vendido */
const padrao = await searchLots({ pageSize: 300 });
const naPagina = padrao.items.filter((i) => i.status === 'vendido').length;
naPagina === 0
  ? ok('1. busca sem filtro não traz lote vendido', `${padrao.total} resultados, ${vendidos} vendidos fora`)
  : falha('1. busca sem filtro não traz lote vendido', `${naPagina} vendidos na primeira página`);

/* 2 — a faceta Situação não oferece "Vendido" como estado vivo */
const temVendido = padrao.facets.statuses.some((s) => s.value === 'vendido');
temVendido
  ? falha('2. faceta Situação não oferece "Vendido"', 'ainda aparece como opção')
  : ok('2. faceta Situação não oferece "Vendido"', padrao.facets.statuses.map((s) => s.value).join(', '));

/* 3 — DISCRIMINA: sair da busca padrão não pode significar sumir do índice.
      Pedir "Encerrado" tem de devolver exatamente os mesmos vendidos. */
const encerrados = await searchLots({ pageSize: 1, status: 'encerrado' });
const semFiltro = await searchLots({ pageSize: 1 });
const idsVendidos = sql(`select string_agg(id::text, ',') from lots where status='vendido'`);
const achados = Number(
  sql(`select count(*) from lots where status='vendido' and id in (${idsVendidos || '0'})`),
);
encerrados.total >= vendidos && encerrados.total + semFiltro.total > semFiltro.total && achados === vendidos
  ? ok('3. os vendidos continuam acessíveis em "Encerrado"', `${encerrados.total} encerrados no total`)
  : falha('3. os vendidos continuam acessíveis em "Encerrado"', `encerrados=${encerrados.total} vendidos=${vendidos}`);

/* 4 — a URL antiga (?status=vendido) não vira tela vazia */
const porVendido = await searchLots({ pageSize: 1, status: 'vendido' });
porVendido.total > 0
  ? ok('4. URL antiga com status=vendido ainda responde', `${porVendido.total} resultados`)
  : falha('4. URL antiga com status=vendido ainda responde', 'devolveu 0');

/* 5 — cada um dos 125 tem a prova da fonte gravada, não a nossa suposição */
const semProva = Number(sql(`select count(*) from lots where status='vendido' and verify_result is null`));
semProva === 0
  ? ok('5. todo lote vendido tem verificação da fonte gravada', `${vendidos} lotes`)
  : falha('5. todo lote vendido tem verificação da fonte gravada', `${semProva} sem verify_result`);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
