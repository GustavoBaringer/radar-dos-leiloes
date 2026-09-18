import * as cheerio from 'cheerio';
import { fetchText, fetchJson } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart, maskPlate } from '../core/normalize.js';

const BASE = 'https://www.freitasleiloeiro.com.br';

// GoCache bloqueia UA não-browser e a cadeia TLS é incompleta (medido via
// undici: UNABLE_TO_VERIFY_LEAF_SIGNATURE; só passa com a verificação desligada).
const OPTS = { insecureTls: true, gapMs: 1100 };

/** "dd/MM/yyyy HH:mm(:ss)" no fuso da fonte (America/Sao_Paulo, sem DST desde 2019). */
function brTzToUtc(datetime: string): Date | null {
  const m = datetime.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s = '00'] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h + 3, +mi, +s));
  return isNaN(dt.getTime()) ? null : dt;
}

function parseBrMoney(s?: string | null): number | null {
  const n = Number((s ?? '').replace(/R\$\s*/i, '').replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function mapStatusName(nome?: string | null): LotStatus {
  const n = (nome ?? '').toLowerCase();
  if (n.includes('aberto')) return 'aberto';
  if (n.includes('agendad')) return 'agendado';
  if (n.includes('vendid') || n.includes('arrematad')) return 'vendido';
  if (n.includes('encerrad')) return 'encerrado';
  return 'sem_data';
}

function mapFuel(desc: string): string | null {
  const u = desc.toUpperCase();
  if (/(ELÉTRICO|ELETRICO)/.test(u)) return 'eletrico';
  if (/(HÍBRIDO|HIBRIDO)/.test(u)) return 'hibrido';
  if (/(DIESEL|DIE SEL)/.test(u)) return 'diesel';
  if (/GASOL.*ALC|ALC.*GASOL|FLEX/.test(u)) return 'flex';
  if (/GASOL/.test(u)) return 'gasolina';
  if (/ALC/.test(u)) return 'alcool';
  return null;
}

interface FreitasDetail {
  abertura: string | null;
  auctioneer: string | null;
  modalidade: string | null;
  local: string | null;
  city: string | null;
  state: string | null;
  visitation: string | null;
  lanceInicial: number | null;
  incremento: number | null;
  comissaoPct: number | null;
  despesas: number | null;
  obs: string | null;
}

async function fetchDetail(leilaoId: number, loteNumero: number): Promise<FreitasDetail | null> {
  try {
    const res = await fetchText(`${BASE}/Leiloes/LoteDetalhes?leilaoId=${leilaoId}&loteNumero=${loteNumero}`, OPTS);
    if (res.status !== 200) return null;
    const $ = cheerio.load(res.body);

    const row = (label: string): string | null => {
      const th = $('th')
        .filter((_, el) => $(el).text().trim().toLowerCase().startsWith(label.toLowerCase()))
        .first();
      if (!th.length) return null;
      return th.closest('tr').find('td').first().text().trim() || null;
    };

    const smallValue = (label: string): number | null => {
      const small = $('small')
        .filter((_, el) => $(el).text().trim().toLowerCase() === label.toLowerCase())
        .first();
      if (!small.length) return null;
      return parseBrMoney(small.prev('div').text().trim());
    };

    const li = $('li')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .join(' | ');
    const com = li.match(/([\d.,]+)%\s*referente à comissão/);
    const desp = li.match(/Despesas operacionais[^R]*R\$\s*([\d.,]+)/);

    const local = row('Local do leilão');
    const visitacao =
      li
        .split('Visitação/Retirada:')[1]
        ?.split('|')[0]
        .trim() ?? null;

    /**
     * A cidade do lote é a do PÁTIO DE RETIRADA, não a do pregão.
     *
     * MEDIDO em 18/09: 691 lotes têm retirada em "…SANTA BARBARA D OESTE/SP" e
     * 666 deles ficavam SEM cidade — o extrator lia "Local do leilão", que para
     * esses não traz o par cidade/UF. Pior: os outros 25 recebiam "Santo André",
     * a cidade do PREGÃO, e ficavam apontando para o lugar errado.
     *
     * A retirada vem primeiro porque é onde o bem está. "Local do leilão" fica
     * como reserva, para o caso de a fonte não publicar a visitação.
     */
    const cidadeDe = (texto: string | null) => {
      const seg = (texto ?? '').split(/\s-\s/).pop()?.trim() ?? '';
      return seg.match(/^(.+?)\/([A-Za-z]{2})$/);
    };
    const cityState = cidadeDe(visitacao) ?? cidadeDe(local);

    return {
      abertura: row('Abertura p/ lances'),
      auctioneer: row('Leiloeiro'),
      modalidade: row('Modalidade'),
      local,
      city: cityState?.[1].trim() ?? null,
      state: cityState?.[2].toUpperCase() ?? null,
      visitation: visitacao,
      lanceInicial: smallValue('Lance Inicial'),
      incremento: smallValue('Incremento Mínimo'),
      comissaoPct: com ? Number(com[1].replace(',', '.')) : null,
      despesas: parseBrMoney(desp?.[1]),
      obs: $('.text-secondary.pt-2.small').first().text().trim() || null,
    };
  } catch {
    return null;
  }
}

async function fetchStatus(leilaoId: number, loteNumero: number): Promise<{ status: LotStatus; nome: string | null } | null> {
  try {
    const { status, data } = await fetchJson<{ success: boolean; message: { nome?: string } | null }>(
      `${BASE}/Leiloes/RetornarLoteStatus?leilaoId=${leilaoId}&loteNumero=${loteNumero}`,
      OPTS,
    );
    if (status !== 200 || !data?.message) return null;
    return { status: mapStatusName(data.message.nome), nome: data.message.nome ?? null };
  } catch {
    return null;
  }
}

async function fetchPhotos(leilaoId: number, loteNumero: number): Promise<string[]> {
  try {
    const res = await fetchText(`${BASE}/Leiloes/ListarFotosLote?leilaoId=${leilaoId}&loteNumero=${loteNumero}`, OPTS);
    if (res.status !== 200) return [];
    const $ = cheerio.load(res.body);
    const hrefs: string[] = [];
    $('a[data-gallery="fotosgallery"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) hrefs.push(href);
    });
    return hrefs.filter((h, i) => hrefs.indexOf(h) === i).slice(0, 30);
  } catch {
    return [];
  }
}

interface CardRaw {
  href: string;
  leilaoId: number;
  loteNumero: number;
  lote: string;
  date: string;
  time: string;
  desc: string;
  vlr: number | null;
  lanceLabel: string;
  details: string[];
  btn: string;
  img: string | null;
}

function parseCard($: cheerio.CheerioAPI, $c: cheerio.Cheerio<any>): CardRaw | null {
  const a = $c.find('a[href*="LoteDetalhes"]').attr('href');
  const m = a?.match(/leilaoId=(\d+)[^&]*&loteNumero=(\d+)/i);
  if (!m) return null;
  const desc = $c.find('.cardLote-descVeic').text().trim();
  const img = $c.find('.cardLote-img').attr('src') ?? null;
  const [date = '', time = ''] = $c
    .find('.cardLote-data span')
    .map((_, el) => $(el).text().trim())
    .get();
  return {
    href: a!,
    leilaoId: Number(m[1]),
    loteNumero: Number(m[2]),
    lote: $c.find('.cardLote-lote').text().trim(),
    date,
    time,
    desc,
    vlr: parseBrMoney($c.find('.cardLote-vlr').text().trim()),
    lanceLabel: $c.find('.cardLote-lance').text().trim(),
    details: $c
      .find('.cardLote-details')
      .text()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    btn: $c.find('.cardLote-btn').text().trim(),
    img,
  };
}

export const freitas: Connector = {
  def: {
    id: 'freitas',
    name: 'Freitas Leiloeiro',
    platform: 'própria',
    method: 'html',
    tier: 2,
    siteUrl: BASE,
    notes: 'HTML + AJAX (GoCache, UA de browser obrigatório). Cadeia TLS incompleta. Fechamento por lote (RetornarTempoEncerramento). Sem km, sem laudo, sem valor de mercado.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;
    let httpStatus = 0;

    for (let page = 1; lots.length < limit; page++) {
      const res = await fetchText(
        `${BASE}/Leiloes/PesquisarLotes?Categoria=1&PageNumber=${page}&TopRows=100`,
        OPTS,
      );
      httpStatus = res.status;
      const body = res.body;
      const $ = cheerio.load(body);
      const cards = $('.cardlote').toArray();
      if (!cards.length || body.includes('Nenhum lote localizado')) break;
      fetched += cards.length;

      for (const cardEl of cards) {
        if (lots.length >= limit) break;
        const c = parseCard($, $(cardEl));
        if (!c || looksLikePart(c.desc)) {
          skipped++;
          continue;
        }

        const st = await fetchStatus(c.leilaoId, c.loteNumero);
        const status = st?.status ?? mapStatusName(c.btn);

        // Lance inicial é POR LOTE no Freitas (medido: 1=27k, 7=15k no mesmo
        // leilão). O card rotula "Lance Inicial" ou "Maior lance": só o detalhe
        // do próprio lote dá o mínimo exato quando há maior lance.
        const dl = await fetchDetail(c.leilaoId, c.loteNumero);
        const photos = status === 'aberto' || status === 'agendado' ? await fetchPhotos(c.leilaoId, c.loteNumero) : [];
        if (!photos.length && c.img) photos.push(c.img);

        const dateTxt = c.date ? `${c.date} ${c.time}` : null;
        const cardEnd = dateTxt ? brTzToUtc(dateTxt) : null;
        const auctionStart = dl?.abertura ? brTzToUtc(dl.abertura) : null;
        const isMaiorLance = /maior lance/i.test(c.lanceLabel);

        const parsed = parseTitle(c.desc);
        // A fonte já entrega mascarada ("F__-___4"), mas passar pelo mascarador
        // do projeto garante o formato único mesmo se a fonte mudar de ideia.
        const plateRaw = c.desc.match(/PLACA:\s*([A-Z0-9_*\-]+)/i)?.[1] ?? null;
        const plateMasked = plateRaw && /\d{3,}/.test(plateRaw.replace(/[_*\-]/g, '')) ? maskPlate(plateRaw) : plateRaw;
        const sellerName = c.details[0] ?? (dl?.obs?.match(/Veículos do Grupo\s+([\w]+)/i)?.[1] ?? null);

        const obsTxt = `${(dl?.obs ?? '').toLowerCase()}`;
        const docType =
          obsTxt.includes('sucata') ? 'sucata' : obsTxt.includes('sinistr') ? 'sinistrado' : null;

        const lot: CanonicalLot = {
          sourceId: 'freitas',
          externalId: `${c.leilaoId}-${String(c.loteNumero).padStart(3, '0')}`,
          lotUrl: `${BASE}${c.href}`,
          titleRaw: c.desc,
          brand: parsed.brand,
          model: parsed.model,
          version: parsed.version,
          yearMake: parsed.yearMake,
          yearModel: parsed.yearModel,
          km: null,
          color: c.desc.split(',').pop()?.trim() || null,
          fuel: mapFuel(c.desc),
          plateMasked,
          docType,
          sourceCategory: null,
          closingModel: 'timer_por_lote',
          auctionStartUtc: auctionStart,
          auctionEndUtc: status === 'aberto' ? cardEnd : null,
          sourceTz: 'America/Sao_Paulo',
          status,
          currentBid: isMaiorLance ? c.vlr : null,
          minBid: isMaiorLance ? dl?.lanceInicial : c.vlr,
          bidIncrement: dl?.incremento ?? null,
          appraisal: null,
          feesPct: dl?.comissaoPct ?? null,
          feesAmount: dl?.despesas ?? null,
          auctioneerName: dl?.auctioneer ?? null,
          auctioneerReg: null,
          sellerName,
          sellerType: classifySeller(sellerName) as any,
          yard: dl?.visitation ?? null,
          city: dl?.city ?? null,
          state: dl?.state ?? null,
          photos,
          financeable: null,
          hasReport: null,
          raw: {
            leilaoId: c.leilaoId,
            loteNumero: c.loteNumero,
            lote: c.lote,
            modalidade: dl?.modalidade,
            detalhes: c.details,
            statusFonte: st?.nome ?? null,
            obs: dl?.obs,
          },
        };
        lots.push(lot);
      }
      if (cards.length < 100) break;
    }

    return { lots, fetched, skipped, httpStatus };
  },
};