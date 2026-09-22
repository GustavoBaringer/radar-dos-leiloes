/**
 * Três conectores novos (leiloar, leiloesbr, leilotech), achados na medição
 * de cobertura de leiloeiro de 22/09: 5 plataformas SaaS tinham lote real e
 * nenhum conector. Este portão prova EFEITO contra a rede real — não que o
 * arquivo existe, que os 3 trazem lote de verdade, com cidade/status/preço,
 * não uma página de erro disfarçada de sucesso (mesma discriminação do
 * teste-navegador-waf.mjs para superbid/caixa).
 *
 * sishp (8 domínios) e vip-leiloes (1) ficaram de fora: sishp exige sessão +
 * token por-requisição (action=0/1 com `mid` assinado) que curl puro não
 * resolve; vip-leiloes é ou revenda do bomvalor (kronbergleiloes, já coberto)
 * ou um portal com redirect infinito (vipleiloes.com.br) — sem catálogo
 * público nenhum dos dois.
 */
import { leiloar } from '../src/connectors/leiloar.ts';
import { leiloesbr } from '../src/connectors/leiloesbr.ts';
import { leilotech } from '../src/connectors/leilotech.ts';

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

// DISCRIMINA: mais de um status entre os três juntos — um conector que grava
// tudo como 'aberto' passaria pelo checa() acima sem provar que ele LÊ status.
const statusVistos = new Set([...rLeiloar.lots, ...rLeiloesbr.lots, ...rLeilotech.lots].map((l) => l.status));
statusVistos.size >= 2
  ? ok('discrimina status (não é tudo aberto por padrão)', [...statusVistos].join(','))
  : falha('discrimina status (não é tudo aberto por padrão)', [...statusVistos].join(','));

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
