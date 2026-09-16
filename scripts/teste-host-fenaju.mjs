/**
 * O `host()` da descoberta descartava domínio que existe.
 *
 * Os casos abaixo são LITERAIS do que a FENAJU publica — foram achados medindo o
 * campo `dominio` dos leiloeiros que contávamos como "sem site". Um teste com
 * valores inventados não pegaria nenhum deles.
 */
import { readFileSync } from 'node:fs';

// A função não é exportada; o teste avalia o módulo com um shim mínimo para não
// obrigar a mudar a fronteira do arquivo só por causa do teste.
const src = readFileSync('src/core/descoberta.ts', 'utf8');
const corpo = /function host\(v\?: string \| null\): string \| null \{[\s\S]*?\n\}/.exec(src)[0]
  .replace(/: string \| null/g, '').replace(/v\?/, 'v');
const host = new Function(`${corpo}; return host;`)();

const CASOS = [
  // sujeira real, colhida do campo `dominio` da FENAJU numa amostra de ~500
  ['https://.rocketleiloes.com.br">', 'rocketleiloes.com.br'],
  ['https://www.vipleiloes.com.br\nE-mail: robertojpinhojr@gmail.com', 'vipleiloes.com.br'],
  // lixo real que DEVE continuar sendo descartado
  ['comercial:', null],
  ['000000000000000000000000', null],
  ['http://brunna.csoares@gmail.com', null],
  ['www.tamiriscarvalholeiloeira@gmail.com', null],
  ['https://&nbsp;www.dsleiloes.com.br', 'dsleiloes.com.br'],
  ['http://http://www.romeuherter.com.br/', 'romeuherter.com.br'],
  ['https://maisleilao.com.br, www.brenohenriqueleiloes.com.br', 'maisleilao.com.br'],
  ['  WWW.Exemplo.COM.BR  ', 'exemplo.com.br'],
  ['https://sitio.com.br/leiloes?a=1', 'sitio.com.br'],
  ['exemplo.com.br.', 'exemplo.com.br'],
  // o que deve continuar sendo descartado
  ['contato@leiloeiro.com.br', null],
  ['', null],
  [null, null],
  ['nao-e-dominio', null],
  ['http://', null],
];

const falhas = [];
for (const [entrada, esperado] of CASOS) {
  const obtido = host(entrada);
  const ok = obtido === esperado;
  console.log(`  ${ok ? 'PASSA' : 'FALHA'}  ${JSON.stringify(entrada)} -> ${JSON.stringify(obtido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
  if (!ok) falhas.push(`${entrada}: esperado ${esperado}, obtido ${obtido}`);
}
console.log(falhas.length ? `\nFALHOU:\n- ${falhas.join('\n- ')}` : '\nVERDE: o parser de domínio aceita o sujo e recusa o inválido.');
process.exit(falhas.length ? 1 : 0);
