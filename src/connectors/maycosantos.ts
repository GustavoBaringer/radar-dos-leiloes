import { fetchJson } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { classifyAsset, classifySeller, looksLikeCollectible, looksLikePart, parseTitle } from '../core/normalize.js';

const API = 'https://maycosantos.lel.br/api/lotes.json';

function data(v?: string | null): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function status(v?: string | null, fim?: Date | null): LotStatus {
  if (/aberto|ativo/i.test(String(v ?? ''))) return fim && fim.getTime() < Date.now() ? 'encerrado' : 'aberto';
  if (/vendid|arrematad/i.test(String(v ?? ''))) return 'vendido';
  if (/encerrad|fechad|cancelad/i.test(String(v ?? ''))) return 'encerrado';
  return fim ? (fim.getTime() > Date.now() ? 'agendado' : 'encerrado') : 'sem_data';
}

function mapLot(l: any, leiloeiro: any): CanonicalLot | null {
  const titulo = String(l?.titulo ?? '').trim();
  const descricao = String(l?.descricao ?? '').trim();
  const categoria = String(l?.categoria ?? '').trim() || null;
  if (!titulo) return null;

  // Lista oficial de RR, mas o catálogo atual é coleção/Hot Wheels. Sem este
  // bloqueio, "Volkswagen Golf MK2" e "Toyota Tundra" viram veículo real.
  const textoEscopo = `${titulo} ${descricao} ${categoria ?? ''} ${l?.leilao ?? ''}`;
  if (looksLikeCollectible(textoEscopo) || looksLikePart(textoEscopo)) return null;

  const cls = classifyAsset(`${titulo} ${descricao}`, categoria, l?.leilao ?? null);
  const parsed = cls.assetType === 'veiculo' ? parseTitle(titulo) : { brand: null, model: null, version: null, yearMake: null, yearModel: null };
  const fim = data(l?.encerramento);
  return {
    sourceId: 'maycosantos',
    externalId: String(l.id),
    lotUrl: l.url ?? `https://maycosantos.lel.br/leilao?id=${l.id}`,
    titleRaw: titulo,
    assetType: cls.assetType,
    vehicleType: cls.vehicleType,
    sourceCategory: categoria,
    closingModel: 'timer_por_lote',
    auctionStartUtc: data(l?.abertura),
    auctionEndUtc: fim,
    sourceTz: 'America/Boa_Vista',
    status: status(l?.situacao, fim),
    brand: parsed.brand,
    model: parsed.model,
    version: parsed.version,
    yearMake: parsed.yearMake,
    yearModel: parsed.yearModel,
    currentBid: num(l?.lance_atual),
    minBid: num(l?.lance_minimo),
    bidIncrement: num(l?.incremento),
    auctioneerName: leiloeiro?.nome ?? 'Mayco Silva dos Santos',
    auctioneerReg: leiloeiro?.matricula ?? 'JUCERR 006/17',
    sellerType: classifySeller(null) as any,
    city: l?.cidade ?? leiloeiro?.cidade ?? null,
    state: l?.estado ?? leiloeiro?.estado ?? null,
    photos: l?.foto ? [String(l.foto)] : [],
    raw: { descricao, categoria, leilao: l?.leilao ?? null, edital: l?.edital ?? null },
  };
}

export const maycosantos: Connector = {
  def: {
    id: 'maycosantos',
    name: 'Mayco Santos',
    platform: 'própria',
    method: 'api',
    tier: 4,
    siteUrl: 'https://maycosantos.lel.br',
    notes: 'Lista oficial de RR (DOCX). API /api/lotes.json; catálogo atual é Hot Wheels/colecionáveis e é descartado pelo filtro de escopo até publicar imóvel/veículo real.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const { status: httpStatus, data } = await fetchJson<any>(API, { gapMs: 900, timeoutMs: 30000 });
    const itens: any[] = Array.isArray(data?.lotes) ? data.lotes : [];
    const lots: CanonicalLot[] = [];
    let skipped = 0;
    for (const it of itens) {
      if (lots.length >= limit) break;
      const lot = mapLot(it, data?.leiloeiro ?? null);
      if (lot) lots.push(lot);
      else skipped++;
    }
    return { lots, fetched: itens.length, skipped, httpStatus };
  },
};
