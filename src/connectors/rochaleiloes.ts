import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import * as campos from '../core/campos.js';
import { parseTitle, classifySeller } from '../core/normalize.js';

const HOST = 'https://rochaleiloes.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decode(html: string) { return html.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&'); }
function banners(html: string): any[] {
  const s = decode(html);
  const start = s.indexOf(':banners="');
  if (start < 0) return [];
  let i = start + 10, depth = 0, inStr = false, esc = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else { if (c === '"') inStr = true; else if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) { i++; break; } } }
  }
  return JSON.parse(s.slice(start + 10, i));
}
function statusDe(l: any, le: any): LotStatus {
  if (l.lote_status === 'encerrado' || le.leilao_encerrado) return 'encerrado';
  if (l.lote_status === 'ativo') return 'aberto';
  return 'sem_data';
}
// A home embute `:banners="..."` onde cada banner traz `leilao` e `lotes`.
// Os lotes NÃO trazem foto. A página `/lote/<id>` expõe `:fotos="[{img,thumb,path}]"`
// mas a URL que o próprio site monta — `/storage/<path>/<img>` — responde 404 para
// toda a árvore `/storage` (inclusive `rochaleiloes/logos`, que a home referencia).
// Ou seja: a origem não serve as imagens. Não emitimos URL quebrada; photos fica vazio.

export const rochaleiloes: Connector = {
  def: { id: 'rochaleiloes', name: 'Rocha Leilões', platform: 'Rocha Leilões Vue/Laravel', method: 'json-embedded', tier: 3, siteUrl: HOST, notes: 'Home embute JSON em <home-banners :banners>; cada banner contém leilão e lotes.' },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let httpStatus = 0;
    let r;
    try { r = await fetchText(`${HOST}/`, { headers: { 'user-agent': UA }, gapMs: 1100 }); } catch { return { lots, fetched: 0, skipped: 0, httpStatus }; }
    httpStatus = r.status;
    if (r.status !== 200) return { lots, fetched: 0, skipped: 0, httpStatus };
    let fetched = 0;
    for (const b of banners(r.body)) {
      const le = b.leilao ?? {};
      for (const l of b.lotes ?? []) {
        if (lots.length >= limit) break;
        fetched++;
        const titulo = String(l.lote_titulo ?? le.leilao_titulo ?? '').trim();
        if (!titulo) continue;
        const parsed = parseTitle(titulo);
        const local = campos.localDeTexto(`${titulo} ${le.leilao_descricao ?? ''}`);
        lots.push({
          sourceId: 'rochaleiloes',
          externalId: String(l.id),
          lotUrl: `${HOST}/lote/${l.id}`,
          auctioneerName: 'Rocha Leilões',
          titleRaw: titulo,
          brand: parsed.brand,
          model: parsed.model,
          version: parsed.version,
          yearMake: parsed.yearMake,
          yearModel: parsed.yearModel,
          assetType: l.lote_tipo === 'veiculo' || parsed.brand ? 'veiculo' : 'imovel',
          docType: le.leilao_tipo ?? null,
          closingModel: 'timer_por_lote',
          auctionStartUtc: le.leilao_1_data ? new Date(le.leilao_1_data.replace(' ', 'T') + '-03:00') : null,
          auctionEndUtc: b.proxima_data_leilao ? new Date(String(b.proxima_data_leilao).replace(' ', 'T') + '-03:00') : null,
          sourceTz: 'America/Sao_Paulo',
          status: statusDe(l, le),
          minBid: Number(l.lote_valor_2 || l.lote_valor_1 || 0) || null,
          appraisal: Number(l.lote_avaliacao || 0) || null,
          sellerType: classifySeller(null) as any,
          city: local?.city ?? null,
          state: local?.uf ?? null,
          photos: [],
          raw: { leilaoId: le.id },
        });
      }
    }
    return { lots, fetched, skipped: fetched - lots.length, httpStatus };
  },
};
