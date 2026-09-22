/**
 * Testa os verificadores contra casos REAIS que a investigação em par produziu.
 *
 * O caso do `sem_licitante` é o que mais importa: um par de subagentes
 * (confirmador + refutador) derrubou a leitura ingênua de que ele significa
 * encerrado — o refutador achou um leilão judicial de duas praças em que o
 * MESMO lote, na MESMA URL, reabre com lance mínimo de 50%. Se este teste ficar
 * verde por acaso, o agregador some com a praça mais barata do país.
 */
import { VERIFICADORES } from '../src/core/verificacao.ts';

const CASOS = [
  { nome: 'condicional (praça única, edital sem reoferta)', fonte: 'soleon',
    url: 'https://ricoleiloes.com.br/item/34098/detalhes?page=2', espera: 'encerrado' },
  { nome: 'sem_licitante COM 2ª praça futura (CPC 891)', fonte: 'soleon',
    url: 'https://quadradoleiloes.com.br/item/281/detalhes?page=1', espera: 'agendado' },
  // 37766: as duas praças (14/09 e 17/09) já passaram, sem marca "ENCERRADO"
  // explícita na página — ficava indeterminado com verify_fails=6 e nunca fechava.
  { nome: 'sem_licitante com AMBAS as praças já passadas (sem marca de encerrado)', fonte: 'soleon',
    url: 'https://infinityleiloes.com.br/item/1172/detalhes?page=1', espera: 'encerrado' },
  // 9606 e 9641 (fixtures antigas) já venderam entre uma rodada e outra —
  // mesma droga do "caso real" que muda de estado sob nossos pés.
  { nome: 'aberto_lance (controle: não pode fechar)', fonte: 'soleon',
    url: 'https://rjleiloes.com.br/item/84756/detalhes?page=2', espera: 'aberto' },
  { nome: 'aguarde_abertura (controle: não pode fechar)', fonte: 'soleon',
    url: 'https://tribunaleiloes.com.br/item/3248/detalhes?page=1', espera: 'aberto|agendado' },
];

const falhas = [];
let i = 0;
for (const c of CASOS) {
  const host = new URL(c.url).host;
  const r = await VERIFICADORES[c.fonte].verificar(host, [{ id: ++i, externalId: null, lotUrl: c.url, categoria: null }]);
  const got = r.get(i);
  const ok = c.espera.split('|').includes(got.veredito);
  console.log(`  ${ok ? 'PASSA' : 'FALHA'}  ${c.nome}\n         esperado=${c.espera} obtido=${got.veredito} "${got.sinal}"`);
  if (!ok) falhas.push(`${c.nome}: esperado ${c.espera}, obtido ${got.veredito}`);
  await new Promise((s) => setTimeout(s, 1200));
}

// A propriedade que não pode quebrar NUNCA: lote com praça futura anunciada na
// página jamais pode ser encerrado. É o caso do leilão judicial de duas praças
// (CPC 891), em que o mesmo lote reabre com lance mínimo de 50% — fechá-lo faz
// o agregador esconder justamente a praça mais barata.
import { execSync } from 'node:child_process';
const sql = (q) => execSync(`docker exec -i leilao-db psql -U leilao -d leilao -t -A -F'|'`, { input: q, encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((l)=>l.split('|'));

console.log('\n--- nenhum lote com praça futura pode ser encerrado ---');
{
  const amostra = sql(`SELECT id, lot_url FROM lots WHERE source_id='soleon' AND lot_url IS NOT NULL
                        AND verify_result ILIKE '%licitante%' ORDER BY random() LIMIT 6`);
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
  let conferidos = 0;
  for (const [id, url] of amostra) {
    const html = await (await fetch(url, { headers: { 'user-agent': UA } })).text();
    // Leitura independente da do verificador: se a página anuncia praça futura,
    // o veredito não pode ser 'encerrado'.
    const temFutura = [...html.matchAll(/Data\s+\d?[ºo]?\s*Leil[ãa]o:?\s*<\/strong>?\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/gi)]
      .some((m) => Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '23'}:${m[5] ?? '59'}:00-03:00`) > Date.now());
    const r = await VERIFICADORES.soleon.verificar(new URL(url).host, [{ id: Number(id), externalId: null, lotUrl: url, categoria: null }]);
    const v = r.get(Number(id)).veredito;
    conferidos++;
    console.log(`  lote ${id}: praça futura=${temFutura} -> ${v}`);
    if (temFutura && v === 'encerrado') falhas.push(`lote ${id} tem praça futura e foi ENCERRADO`);
    await new Promise((s) => setTimeout(s, 1200));
  }
  if (!conferidos) console.log('  (sem amostra de sem_licitante no banco)');
}

console.log('\n--- leilo: separa vivo de encerrado? ---');
// Vivos: vistos na coleta mais recente. Suspeitos: parados há mais de 24h.
const vivos = sql(`SELECT id, external_id, source_category FROM lots WHERE source_id='leilo' AND status='aberto' AND collected_at > now() - interval '30 minutes' ORDER BY random() LIMIT 4`);
const velhos = sql(`SELECT id, external_id, source_category FROM lots WHERE source_id='leilo' AND status='aberto' AND collected_at < now() - interval '24 hours' ORDER BY random() LIMIT 4`);
const entrada = [...vivos, ...velhos].map(([id, ext, cat]) => ({ id: Number(id), externalId: ext, lotUrl: null, categoria: cat }));
if (entrada.length) {
  const r = await VERIFICADORES.leilo.verificar('api.leilo.com.br', entrada);
  const cls = (lista) => lista.map(([id]) => r.get(Number(id))?.veredito).join(',');
  console.log(`  vistos agora (esperado aberto):      ${cls(vivos)}`);
  console.log(`  parados há 24h+ (esperado encerrado): ${cls(velhos)}`);
  // Exigir 'aberto' e não "qualquer coisa menos encerrado": indeterminado em
  // todos os lotes passava como verde e escondia o parser lendo a resposta errada.
  const vivosCls = cls(vivos).split(',');
  if (vivos.length && !vivosCls.every((v) => v === 'aberto')) {
    falhas.push(`leilo: lote visto na coleta mais recente deu ${vivosCls.join(',')} (esperado aberto)`);
  }
  if (velhos.length && cls(velhos).split(',').every((v) => v === 'indeterminado')) {
    falhas.push('leilo: nenhum veredito para os lotes parados — a varredura não completou');
  }
} else {
  console.log('  (sem amostra)');
}

console.log(falhas.length ? `\nFALHOU:\n- ${falhas.join('\n- ')}` : '\nVERDE: os verificadores separam vivo de encerrado.');
process.exit(falhas.length ? 1 : 0);
