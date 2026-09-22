/**
 * superbid (Cloudflare) e caixa (Radware/ShieldSquare) exigem um navegador de
 * verdade — MEDIDO em 22/09: o fetch cru (`fetchJson`/`request`) bate no
 * desafio quase sempre (1 sucesso em 1.458 tentativas do superbid). Este
 * portão prova o EFEITO da correção contra a rede real, não que a função
 * existe: os dois conectores voltam com http=200 e lotes de verdade.
 */
import { caixa } from '../src/connectors/caixa.ts';
import { superbid } from '../src/connectors/superbid.ts';

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => {
  falhas++;
  console.log(`  FALHA ${t} — ${d}`);
};

const rs = await superbid.collect({ limit: 20 });
rs.httpStatus === 200 && rs.lots.length > 0
  ? ok('1. superbid passa do desafio do Cloudflare', `http=${rs.httpStatus} lotes=${rs.lots.length}`)
  : falha('1. superbid passa do desafio do Cloudflare', `http=${rs.httpStatus} lotes=${rs.lots.length}`);

const rc = await caixa.collect({ limit: 20 });
rc.httpStatus === 200 && rc.lots.length > 0
  ? ok('2. caixa passa do desafio do Radware', `http=${rc.httpStatus} lotes=${rc.lots.length}`)
  : falha('2. caixa passa do desafio do Radware', `http=${rc.httpStatus} lotes=${rc.lots.length}`);

// A DISCRIMINAÇÃO que importa: o corpo NÃO pode ser a própria página de
// desafio/CAPTCHA disfarçada de sucesso. Um `httpStatus` 200 sozinho não
// prova nada — a página "Just a moment..." também responde 200.
const pareceDesafio = (lots) => lots.length === 0;
!pareceDesafio(rs.lots) && !pareceDesafio(rc.lots)
  ? ok('3. os lotes vieram de verdade, não de uma página de desafio disfarçada')
  : falha('3. os lotes vieram de verdade, não de uma página de desafio disfarçada', 'zero lotes mapeados');

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
