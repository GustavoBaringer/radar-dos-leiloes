import { fetchJson } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';

const URL_SEARCH = 'https://api.leilo.com.br/v1/lote/busca-elastic';

/**
 * A fonte mais rica do levantamento: traz km, valor de mercado, laudo e custos.
 * Não traz leiloeiro. A busca `campo:geral` da própria API é fuzzy demais
 * ("mercedes b 200" devolveu GLA 200), então ingerimos a categoria inteira
 * e a busca fica no nosso índice.
 */
/** "ABC Def/GHI" -> "abc-def-ghi" */
function slug(v?: string | null): string {
  return (v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'lote';
}

/**
 * A URL pública NÃO é `/lote/{uuid}` — essa rota devolve a página de "não
 * encontrado" (a SPA responde 200 e renderiza o 404, então o status engana).
 * O formato real é `/leilao/{cidade-uf}/{tipo}/{leilao}/{bem}/ano.{ano}/{uuid}`.
 * Os segmentos de slug não precisam bater com os do site, mas o formato sim.
 */
function lotUrl(l: any): string {
  const loc = l.localizacao ?? {};
  const v = l.veiculo ?? {};
  const cidadeUf = slug(`${loc.cidade ?? 'brasil'} ${loc.estado ?? ''}`);
  const tipo = slug(l.tipo ?? 'lotes');
  const leilao = slug(l.leilao?.nome);
  const bem = slug(l.nome);
  const ano = v.anoModelo ?? v.anoFabricacao;
  return `https://www.leilo.com.br/leilao/${cidadeUf}/${tipo}/${leilao}/${bem}/ano${ano ? `.${ano}` : ''}/${l.id}`;
}

/**
 * O CDN publica três tamanhos pelo sufixo: base 460x345, `_media` 1280x960 e
 * `_grande` 4624x3468. O campo `fotosUrls` entrega a base, ilegível no detalhe;
 * `_grande` pesa 679 KB por foto. `_media` é o ponto certo.
 */
function mediaPhoto(url: string): string {
  return url.replace(/(\.[a-z]+)$/i, '_media$1');
}

function mapLot(l: any): CanonicalLot | null {
  const title = l.nome ?? '';
  if (!title || looksLikePart(title)) return null;
  const v = l.veiculo ?? {};
  const valor = l.valor ?? {};
  const loc = l.localizacao ?? {};
  const parsed = parseTitle(title, v.infocarMarca, v.infocarModelo);
  const end = l.dataFim ? new Date(l.dataFim) : null;
  const start = l.leilao?.data ? new Date(l.leilao.data) : null;

  return {
    sourceId: 'leilo',
    externalId: String(l.lelId ?? l.id),
    lotUrl: lotUrl(l),
    titleRaw: title,
    brand: parsed.brand ?? v.infocarMarca ?? null,
    // Ver copart.ts: modelo cru da fonte quebra a busca estrutural.
    model: parsed.model,
    version: parsed.version,
    yearMake: v.anoFabricacao ?? parsed.yearMake,
    yearModel: v.anoModelo ?? parsed.yearModel,
    km: typeof v.km === 'number' ? v.km : null,
    docType: v.retomada && v.retomada !== '-' ? v.retomada : null,
    sourceCategory: l.tipo ?? null,
    closingModel: 'timer_por_lote',
    auctionStartUtc: start,
    auctionEndUtc: end,
    sourceTz: 'UTC',
    status:
      l.situacao === 'LiberadoLeilao' ? (end && end.getTime() < Date.now() ? 'encerrado' : 'aberto') : 'agendado',
    currentBid: valor?.lance?.valor ?? null,
    minBid: valor.minimo ?? null,
    bidIncrement: valor.incremento ?? null,
    appraisal: v.valorMercado ?? null,
    feesPct: valor.comissaoPorcentagem ?? null,
    feesAmount: valor.totalDespesas ?? null,
    auctioneerName: null,
    sellerName: l.comitente?.nome ?? null,
    sellerType: classifySeller(l.comitente?.nome) as any,
    yard: loc.nome ?? null,
    city: loc.cidade ?? null,
    state: loc.estado ?? null,
    photos: Array.isArray(l.fotosUrls) ? l.fotosUrls.slice(0, 30).map(mediaPhoto) : [],
    financeable: l.permiteFinanciamento ?? null,
    hasReport: l.laudoCautelarResultado ? l.laudoCautelarResultado !== 'AUSENTE' : null,
    raw: {
      numero: l.numero,
      leilao: l.leilao?.nome,
      modalidade: l.leilao?.modalidade,
      totalAPagar: valor.totalAPagar,
      quantidadeFotos: l.quantidadeFotos,
      modeloFonte: v.infocarModelo ?? null,
    },
  };
}

export const leilo: Connector = {
  def: {
    id: 'leilo',
    name: 'Leilo',
    platform: 'própria',
    method: 'api',
    tier: 1,
    siteUrl: 'https://www.leilo.com.br',
    notes: 'API Elastic aberta, sem auth e sem Origin. Total no header count. Não expõe leiloeiro.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let status = 0;
    const pageSize = 100;

    // Os valores do campo `tipo` NÃO têm acento. Pedir 'Caminhões' e
    // 'Utilitários' devolvia count:0 em silêncio — duas categorias inteiras
    // simplesmente não entravam no índice. Os reais, medidos: Carros 485,
    // Motos 55, Utilitarios 24, Sucatas 24, Pesados 12, Equipamentos 1, Imoveis 55.
    for (const tipo of ['Carros', 'Motos', 'Utilitarios', 'Sucatas', 'Pesados', 'Equipamentos']) {
      for (let from = 0; lots.length < limit; from += pageSize) {
        const { status: st, data } = await fetchJson<any>(URL_SEARCH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from,
            size: pageSize,
            requisicoesBusca: [{ campo: 'tipo', tipo: 'exata', valor: tipo }],
          }),
          gapMs: 900,
        });
        status = st;
        const items: any[] = Array.isArray(data) ? data : (data?.itens ?? []);
        if (!items.length) break;
        fetched += items.length;
        for (const l of items) {
          const mapped = mapLot(l);
          if (mapped) lots.push(mapped);
          else skipped++;
        }
        if (items.length < pageSize) break;
      }
      if (lots.length >= limit) break;
    }
    return { lots: lots.slice(0, limit), fetched, skipped, httpStatus: status };
  },
};
