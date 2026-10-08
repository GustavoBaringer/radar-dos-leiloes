import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { classifyAsset, classifySeller, looksLikePart, parseTitle } from '../core/normalize.js';
import * as campos from '../core/campos.js';

const API = 'https://api.mcleilaoeireli.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const money = (v: unknown) => Number(v) > 0 ? Number(v) : null;

export const mcleilao: Connector = {
  def: { id: 'mcleilao', name: 'MC Leilão', platform: 'MC Leilão', method: 'api', tier: 3, siteUrl: 'https://www.mcleilao.com.br', notes: 'API pública Angular: POST /leilao/listarLeiloes e GET /lote/buscarLotesPorLeilaoId.' },
  async collect({ limit }): Promise<CollectResult> {
    const headers = { 'user-agent': UA, 'content-type': 'application/json' };
    let r;
    try { r = await fetchText(`${API}/leilao/listarLeiloes`, { method: 'POST', headers, body: JSON.stringify({ status: ['ANDAMENTO', 'LOTEAMENTO', 'SUSPENSO'], maximoRetorno: 100, ordenacao: 'DATA_ENCERRAMENTO', posicao: 0 }), gapMs: 900 }); } catch { return { lots: [], fetched: 0, skipped: 0, httpStatus: 0 }; }
    if (r.status !== 200) return { lots: [], fetched: 0, skipped: 0, httpStatus: r.status };
    let auctions: any[] = []; try { auctions = JSON.parse(r.body); } catch { return { lots: [], fetched: 0, skipped: 0, httpStatus: r.status }; }
    const lots: CanonicalLot[] = []; let fetched = 0, skipped = 0;
    for (const a of auctions) {
      if (lots.length >= limit) break;
      let lr; try { lr = await fetchText(`${API}/lote/buscarLotesPorLeilaoId?idLeilao=${a.id}&maximoRetorno=100&posicao=0`, { headers: { 'user-agent': UA }, gapMs: 900 }); } catch { continue; }
      if (lr.status !== 200) continue;
      let rows: any[] = []; try { rows = JSON.parse(lr.body); } catch { continue; }
      fetched += rows.length;
      for (const x of rows) {
        if (lots.length >= limit) break;
        const title = String(x.descricao ?? a.descricao ?? '').replace(/\s+/g, ' ').trim();
        if (!title || looksLikePart(title)) { skipped++; continue; }
        const parsed = parseTitle(title), kind = classifyAsset(title), local = campos.localDeTexto(title);
        lots.push({ sourceId: 'mcleilao', externalId: String(x.id), lotUrl: `https://www.mcleilao.com.br/#/lote/${x.id}`, titleRaw: title, brand: parsed.brand, model: parsed.model, yearMake: parsed.yearMake, yearModel: parsed.yearModel, assetType: kind.assetType, vehicleType: kind.vehicleType, closingModel: 'timer_por_lote', sourceTz: 'America/Sao_Paulo', status: 'aberto', auctionStartUtc: x.dataAbertura ? new Date(x.dataAbertura) : null, auctionEndUtc: x.dataEncerramento ? new Date(x.dataEncerramento) : null, minBid: money(x.valorInicial), currentBid: money(x.valorFinal), appraisal: money(x.valorInicialPadrao), feesAmount: money(x.valorComissao), sellerName: a.comitente?.nome ?? null, sellerType: classifySeller(a.tipoLeilao?.descricao) as any, city: local?.city ?? a.endereco?.cidade?.descricao ?? null, state: local?.uf ?? null, photos: [], raw: { auctionId: a.id, tenant: 'mcleilao.com.br' } });
      }
    }
    return { lots, fetched, skipped, httpStatus: r.status };
  },
};
