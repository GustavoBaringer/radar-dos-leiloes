/**
 * Conectores novos achados na medição de cobertura de leiloeiro de 22/09.
 * Este portão prova EFEITO contra a rede real — não que o arquivo existe,
 * que cada um traz lote de verdade, com cidade/status/preço, não uma página
 * de erro disfarçada de sucesso (mesma discriminação do
 * teste-navegador-waf.mjs para superbid/caixa).
 *
 * kronleiloes.com.br (indicado pelo usuário) ficou de fora de propósito: é o
 * MESMO catálogo do superbid (offer-query.superbid.net, stores.id:16180,
 * confirmado — 586 lotes com raw.store="KRON LEILÕES" já no banco). Um
 * conector separado duplicaria, não somaria.
 *
 * sishp entrou depois: o `mid` "assinado" era só um campo obrigatório não
 * vazio (`mid=x` passa), mas essa rota só dá contagem por categoria — a
 * lista real é HTML comum sem POST nenhum.
 *
 * vip-leiloes (1, mesmo com a URL de busca que o usuário indicou —
 * /pesquisa/index redireciona pro mesmo /canal em loop) segue de fora: é
 * portal logado, sem catálogo público.
 */
import { leiloar } from '../src/connectors/leiloar.ts';
import { leiloesbr } from '../src/connectors/leiloesbr.ts';
import { leilotech } from '../src/connectors/leilotech.ts';
import { bomvalormercado } from '../src/connectors/bomvalormercado.ts';
import { sishp } from '../src/connectors/sishp.ts';

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => {
  falhas++;
  console.log(`  FALHA ${t} — ${d}`);
};

async function checa(nome, conector, limite) {
  const r = await conector.collect({ limit: limite });
  const semPagina = r.lots.length > 0 && r.lots.every((l) => l.titleRaw && l.titleRaw.length > 3);
  const temCidadeOuPreco = r.lots.some((l) => l.city || l.appraisal || l.currentBid || l.minBid);
  if (r.httpStatus === 200 && r.lots.length > 0 && semPagina && temCidadeOuPreco) {
    ok(`${nome}: traz lote de verdade`, `http=${r.httpStatus} lotes=${r.lots.length} skipped=${r.skipped}`);
  } else {
    falha(
      `${nome}: traz lote de verdade`,
      `http=${r.httpStatus} lotes=${r.lots.length} semPagina=${semPagina} temCidadeOuPreco=${temCidadeOuPreco}`,
    );
  }
  return r;
}

const rLeiloar = await checa('leiloar', leiloar, 40);
const rLeiloesbr = await checa('leiloesbr', leiloesbr, 40);
const rLeilotech = await checa('leilotech', leilotech, 20);
const rBomvalorMercado = await checa('bomvalormercado', bomvalormercado, 40);
const rSishp = await checa('sishp', sishp, 40);

// DISCRIMINA: mais de um status entre os cinco juntos — um conector que
// grava tudo como 'aberto' passaria pelo checa() acima sem provar que ele LÊ status.
const statusVistos = new Set(
  [...rLeiloar.lots, ...rLeiloesbr.lots, ...rLeilotech.lots, ...rBomvalorMercado.lots, ...rSishp.lots].map((l) => l.status),
);
statusVistos.size >= 2
  ? ok('discrimina status (não é tudo aberto por padrão)', [...statusVistos].join(','))
  : falha('discrimina status (não é tudo aberto por padrão)', [...statusVistos].join(','));

// sishp compartilha id entre os 8 domínios (idLeilao=470 responde igual em
// qualquer host) — sem dedupe global por idLote, o mesmo lote visto em dois
// tenants viraria dois registros. Esta é a garantia que protege contra isso.
const idsSishp = rSishp.lots.map((l) => l.externalId);
new Set(idsSishp).size === idsSishp.length
  ? ok('sishp não duplica lote visto em mais de um host da rede', `${idsSishp.length} lotes, todos únicos`)
  : falha('sishp não duplica lote visto em mais de um host da rede', `${idsSishp.length} lotes, ${new Set(idsSishp).size} únicos`);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
