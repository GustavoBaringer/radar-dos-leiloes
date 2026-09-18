/**
 * Quem conduz o pregão, e onde é honesto dizer que não sabemos.
 *
 * Metade da base não tinha leiloeiro porque nove conectores gravavam
 * `auctioneerName: null` fixo — não era extração falhando, era campo nunca
 * preenchido. Três fontes continuam sem, e isso é resultado medido, não
 * pendência: o teste afirma o nulo para que ninguém o preencha com chute.
 */
import { spawnSync } from 'node:child_process';

const sql = (q) =>
  spawnSync('docker', ['exec', 'leilao-db', 'psql', '-U', 'leilao', '-d', 'leilao', '-t', '-A', '-c', q], {
    encoding: 'utf8',
  }).stdout.trim();
const n = (q) => Number(sql(q));

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => {
  falhas++;
  console.log(`  FALHA ${t} — ${d}`);
};
const ativos = "status <> 'encerrado'";

/* 1 — a cobertura geral subiu do buraco de 42,4% que originou a task */
const com = n(`select count(*) from lots where ${ativos} and auctioneer_name is not null`);
const tot = n(`select count(*) from lots where ${ativos}`);
const pct = (100 * com) / tot;
pct >= 60
  ? ok('1. cobertura de leiloeiro', `${com} de ${tot} (${pct.toFixed(1)}%)`)
  : falha('1. cobertura de leiloeiro', `${pct.toFixed(1)}% — era 42,4% antes da 1.4`);

/* 2 — as fontes consertadas, cada uma no patamar que a sua via permite.
      vlance vem no mesmo JSON (quase tudo); leilaopro e bomvalor dependem de
      detalhe por leilão/lote; soleon é o detalhe por lote. */
for (const [fonte, piso] of [
  ['vlance', 90],
  ['leilaopro', 60],
  ['bomvalor', 60],
  ['soleon', 60],
]) {
  const c = n(`select count(*) from lots where ${ativos} and source_id='${fonte}' and auctioneer_name is not null`);
  const t = n(`select count(*) from lots where ${ativos} and source_id='${fonte}'`);
  const p = t ? (100 * c) / t : 0;
  p >= piso
    ? ok(`2. ${fonte}`, `${c}/${t} (${p.toFixed(1)}%)`)
    : falha(`2. ${fonte}`, `${p.toFixed(1)}% < piso de ${piso}% (${c}/${t})`);
}

/* 3 — nenhum nome é domínio. O atalho tentador era virar o tenant
      ("ricoleiloes.com.br") em nome; todo valor gravado veio de campo
      publicado pela fonte, e é isso que esta asserção protege. */
const dominios = n(
  `select count(*) from lots where ${ativos} and auctioneer_name ~* '\\.(com|br|net|pro)\\y|^www\\.|https?://'`,
);
dominios === 0
  ? ok('3. nenhum leiloeiro é domínio ou URL')
  : falha('3. nenhum leiloeiro é domínio ou URL', `${dominios} lotes`);

/* 4 — rótulo SEM nome depois não é leiloeiro, e nem placeholder da fonte.
      "Leiloeiro Oficial José Valero Santos Junior" é nome legítimo com
      tratamento; "Leiloeiro Oficial Exemplo" é dado de teste publicado. */
const rotulos = n(`select count(*) from lots where ${ativos} and (
    auctioneer_name ~* '^(leiloeir[ao]|comiss|cadastrad|lance|lote|edital|aguarde)[\\s(oficial|p[uú]blic[oa])]*$'
    or auctioneer_name ~* '\\y(exemplo|teste|placeholder|sem nome)\\y')`);
rotulos === 0
  ? ok('4. nenhum leiloeiro é rótulo solto ou placeholder')
  : falha('4. nenhum leiloeiro é rótulo solto ou placeholder', `${rotulos} lotes`);

/* 5 — o nulo declarado. Medido em 18/09/2026:
      caixa   — o CSV nacional tem 12 colunas, todas mapeadas, nenhuma é leiloeiro;
                só existiria no PDF do edital, atrás de 5.189 requisições e de um
                antibot que já bloqueia o IP;
      copart  — a API não tem o campo (68 chaves) e o HTML é servido pelo Incapsula;
      suaplat.— a página do lote só diz "Leiloeira cadastrada pelo TJSP", sem nome.
      Se algum destes deixar de ser zero, alguém inventou um valor. */
for (const fonte of ['caixa', 'copart', 'suaplataforma']) {
  const c = n(`select count(*) from lots where ${ativos} and source_id='${fonte}' and auctioneer_name is not null`);
  c === 0
    ? ok(`5. ${fonte} segue sem leiloeiro`, 'a fonte não publica — nulo é o valor correto')
    : falha(`5. ${fonte} segue sem leiloeiro`, `${c} lotes ganharam nome sem fonte conhecida`);
}

/* 6 — os nulos do superbid são de venda direta, não de extração falhando.
      "Tomada de preço" não tem leiloeiro, e as lojas sem nome são consultorias
      e empresas vendendo direto. Se aparecer leilão de verdade sem nome aqui,
      o mapeamento quebrou. */
const superbidSem = n(
  `select count(*) from lots where ${ativos} and source_id='superbid' and auctioneer_name is null`,
);
const superbidLojas = sql(
  `select string_agg(distinct coalesce(nullif(raw->>'store',''),'(sem loja)'), ', ')
     from lots where ${ativos} and source_id='superbid' and auctioneer_name is null`,
);
superbidSem < 400
  ? ok('6. superbid: nulos são venda direta', `${superbidSem} lotes em ${superbidLojas.split(', ').length} lojas`)
  : falha('6. superbid: nulos são venda direta', `${superbidSem} lotes — cresceu, revisar`);

/* 7 — o nome tem de servir de faceta: sem duplicata por sufixo institucional */
const variantes = n(`
  with r as (
    select upper(unaccent(regexp_replace(auctioneer_name,
             '\\s*(LEILOEIR[AO]|P[UÚ]BLIC[AO]|OFICIAL|LEIL[OÕ]ES|LTDA|ME|EIRELI)\\M','','gi'))) raiz
      from lots where ${ativos} and auctioneer_name is not null group by auctioneer_name
  ) select count(*) from (select raiz from r group by raiz having count(*) > 2) x`);
variantes === 0
  ? ok('7. nenhum leiloeiro com 3+ grafias na faceta')
  : falha('7. nenhum leiloeiro com 3+ grafias na faceta', `${variantes} nomes fragmentados`);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
