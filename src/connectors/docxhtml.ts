import * as cheerio from 'cheerio';
import { fetchJson, fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart } from '../core/normalize.js';
import * as campos from '../core/campos.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function abs(base: string, u?: string | null): string | null {
  if (!u) return null;
  try { return new URL(u, base).href; } catch { return null; }
}

function text($el: cheerio.Cheerio<any>): string {
  return $el.text().replace(/\s+/g, ' ').trim();
}

function dinheiro(v?: string | null): number | null {
  const n = Number(String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function dataBr(v?: string | null): Date | null {
  const s = String(v ?? '');
  const m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s*(?:-|a|às?)\s*)?(\d{1,2}):(\d{2})/i);
  if (!m) return null;
  const [, d, mes, ano, h, min] = m;
  const yyyy = ano ? Number(ano) : new Date().getFullYear();
  const t = Date.parse(`${yyyy}-${mes.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function dataRoi(v?: string | null): Date | null {
  const meses: Record<string, string> = { JAN: '01', FEV: '02', MAR: '03', ABR: '04', MAI: '05', JUN: '06', JUL: '07', AGO: '08', SET: '09', OUT: '10', NOV: '11', DEZ: '12' };
  const m = String(v ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').match(/(\d{1,2})\s*\/\s*([A-Z]{3})\s*\/\s*(\d{4}).*?(\d{1,2})h(\d{2})/i);
  if (!m) return dataBr(v);
  const [, d, mes, a, h, min] = m;
  const mm = meses[mes.toUpperCase()];
  if (!mm) return null;
  const t = Date.parse(`${a}-${mm}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:00-03:00`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function statusDe(txt: string, fim?: Date | null): LotStatus {
  if (/finaliz|encerrad|fechado/i.test(txt)) return 'encerrado';
  if (/aguard|n[aã]o\s*iniciad|inicia/i.test(txt)) return 'agendado';
  if (/aberto|andamento|lances/i.test(txt)) return 'aberto';
  if (fim) return fim.getTime() > Date.now() ? 'agendado' : 'encerrado';
  return 'sem_data';
}

function tipo(titulo: string, cat?: string | null): 'veiculo' | 'imovel' | 'outro' {
  const t = `${titulo} ${cat ?? ''}`;
  if (/im[oó]vel|apartamento|casa|terreno|gleba|rural|urbano|loteamento|galp[aã]o/i.test(t)) return 'imovel';
  if (/ve[ií]culo|autom[óo]vel|carro|moto|caminh|fiat|ford|vw|volks|honda|toyota|gm\b|chevrolet|hyundai|renault|peugeot|yamaha/i.test(t)) return 'veiculo';
  return 'outro';
}

function canon(p: {
  host: string; id: string; url: string; titulo: string; foto?: string | null; status?: string; fim?: Date | null;
  min?: number | null; atual?: number | null; avaliacao?: number | null; auctioneer: string; categoria?: string | null;
}): CanonicalLot | null {
  if (!p.titulo || looksLikePart(p.titulo)) return null;
  const assetType = tipo(p.titulo, p.categoria);
  const parsed = assetType === 'veiculo' ? parseTitle(p.titulo) : { brand: null, model: null, version: null, yearMake: null, yearModel: null };
  const local = campos.localDeTexto(p.titulo);
  return {
    sourceId: 'docxhtml',
    externalId: `${p.host}:${p.id}`,
    lotUrl: p.url,
    auctioneerName: p.auctioneer,
    titleRaw: p.titulo,
    brand: parsed.brand,
    model: parsed.model,
    version: parsed.version,
    yearMake: parsed.yearMake,
    yearModel: parsed.yearModel,
    assetType,
    sourceCategory: p.categoria ?? null,
    docType: /extrajud/i.test(`${p.categoria ?? ''} ${p.titulo}`) ? 'extrajudicial' : 'judicial',
    closingModel: 'timer_por_lote',
    auctionStartUtc: null,
    auctionEndUtc: p.fim ?? null,
    sourceTz: 'America/Sao_Paulo',
    status: statusDe(p.status ?? '', p.fim),
    currentBid: p.atual ?? null,
    minBid: p.min ?? null,
    appraisal: p.avaliacao ?? null,
    sellerType: classifySeller(null) as any,
    city: local?.city ?? null,
    state: local?.uf ?? null,
    photos: p.foto ? [p.foto] : [],
    raw: { tenant: p.host, statusTexto: p.status ?? null },
  };
}

async function coletarBenedetto(limit: number): Promise<{ lots: CanonicalLot[]; fetched: number; status: number }> {
  const host = 'benedettoleiloes.com.br';
  const base = `https://${host}`;
  const r = await fetchText(`${base}/leiloes`, { headers: { 'user-agent': UA }, gapMs: 1100 });
  const $ = cheerio.load(r.body);
  const lots: CanonicalLot[] = [];
  $('.leilao-item').each((_, el) => {
    if (lots.length >= limit) return;
    const $c = $(el);
    const href = $c.find('a[href*="/lance/"]').first().attr('href');
    const id = href?.match(/\/lance\/(\d+)/)?.[1];
    const desc = text($c.find('p').first()).replace(/^Processo:.*/i, '').trim();
    const titulo = desc || text($c.find('.media-heading')).replace(/Processo:.*/i, '').trim();
    if (!href || !id || !titulo) return;
    const img = abs(base, $c.find('img').first().attr('src'));
    const datas = text($c.find('.text-default.small').first());
    const fim = dataBr(datas.split(/\ba\b/i).pop());
    const min = dinheiro(text($c.find('.lance-inicial strong').first()));
    const avaliacao = dinheiro(titulo.match(/Avalia[çc][ãa]o:?\s*R\$\s*([\d.,]+)/i)?.[1]);
    const lot = canon({ host, id, url: href, titulo, foto: img?.includes('sem_imagem') ? null : img, status: text($c.find('.label').first()), fim, min, avaliacao, auctioneer: 'Benedetto Leilões' });
    if (lot) lots.push(lot);
  });
  return { lots, fetched: $('.leilao-item').length, status: r.status };
}

async function coletarCentral(limit: number): Promise<{ lots: CanonicalLot[]; fetched: number; status: number }> {
  const host = 'centralsuldeleiloes.com.br';
  const base = 'https://www.centralsuldeleiloes.com.br';
  const home = await fetchJson<any>(`${base}/api/v2/web/next-auctions?page=1&per_page=30&cache=true`, { gapMs: 1100 });
  const leiloes = home.data?.data ?? home.data?.data?.data ?? home.data?.data ?? [];
  const arr = Array.isArray(leiloes) ? leiloes : Array.isArray(home.data?.data) ? home.data.data : [];
  const lots: CanonicalLot[] = [];
  let fetched = 0;
  for (const a of arr) {
    if (lots.length >= limit) break;
    let loteLista;
    try { loteLista = await fetchJson<any>(`${base}/api/v2/web/auction/${a.id}/lots?page=1&per_page=30`, { gapMs: 700 }); } catch { continue; }
    const itens = loteLista.data?.data ?? [];
    fetched += itens.length;
    for (const l of itens) {
      if (lots.length >= limit) break;
      let det: any = l;
      try { det = (await fetchJson<any>(`${base}/api/v2/web/lot/${l.id}`, { gapMs: 400 })).data; } catch { /* lista basta */ }
      const fotos = Array.isArray(det?.photos) ? det.photos : [];
      const foto = fotos[0]?.thumbnail_url ?? fotos[0]?.image_url ?? a.cover?.thumbnail_url ?? a.cover?.image_url ?? null;
      const lot = canon({
        host, id: String(l.id), url: l.url ?? `${base}/leilao/${a.id}/lote/${l.id}`, titulo: l.title,
        foto, status: l.status?.label, fim: l.time_limit ? new Date(l.time_limit) : a.next_date ? new Date(a.next_date) : null,
        min: dinheiro(l.minimum_bid), atual: dinheiro(l.current_bid), avaliacao: dinheiro(l.value),
        auctioneer: campos.nomeDeLeiloeiro(a.auctioneer?.name) ?? 'Central Sul de Leilões', categoria: a.type?.label,
      });
      if (lot) lots.push(lot);
    }
  }
  return { lots, fetched, status: 200 };
}

async function coletarCristiano(limit: number): Promise<{ lots: CanonicalLot[]; fetched: number; status: number }> {
  const host = 'cristianoescolaleiloes.com.br';
  const base = `https://www.${host}`;
  const lots: CanonicalLot[] = [];
  let fetched = 0, status = 0;
  for (const path of ['/lotes', '/lotes/pagina/2', '/lotes/pagina/3']) {
    if (lots.length >= limit) break;
    const r = await fetchText(`${base}${path}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
    status = r.status;
    if (r.status !== 200) continue;
    const $ = cheerio.load(r.body);
    const cards = $('.auction-item').toArray();
    fetched += cards.length;
    for (const el of cards) {
      if (lots.length >= limit) break;
      const $c = $(el);
      const id = String($c.attr('data-id') ?? $c.find('a[href*="/ver-lote/"]').attr('href')?.match(/ver-lote\/(\d+)/)?.[1] ?? '');
      const href = $c.find('a[href*="/ver-lote/"]').first().attr('href');
      const titulo = text($c.find('h2').first()).replace(/\s+/g, ' ');
      if (!id || !href || !titulo) continue;
      const foto = abs(base, $c.find('[data-src]').first().attr('data-src'));
      const fim = dataBr($c.find('time').first().attr('datetime') ?? text($c.find('time').first()));
      const lot = canon({ host, id, url: abs(base, href)!, titulo, foto, status: text($c.find('.badge').last()), fim, auctioneer: 'Cristiano Escola Leilões' });
      if (lot) lots.push(lot);
    }
  }
  return { lots, fetched, status };
}

async function coletarLeiloariaSmart(limit: number): Promise<{ lots: CanonicalLot[]; fetched: number; status: number }> {
  const host = 'leiloariasmart.com.br';
  const base = `https://${host}`;
  const r = await fetchText(`${base}/`, { headers: { 'user-agent': UA }, gapMs: 1100 });
  const $ = cheerio.load(r.body);
  const lots: CanonicalLot[] = [];
  $('.caixa-imoveis').each((_, el) => {
    if (lots.length >= limit) return;
    const $c = $(el);
    const href = $c.find('a[href*="/imovel/"]').first().attr('href');
    const id = href?.match(/\/imovel\/(\d+)/)?.[1];
    const titulo = text($c.find('.info-imovel-2 a').first());
    if (!href || !id || !titulo) return;
    const foto = abs(base, $c.find('img[src*="/_admin_/upload/"]').first().attr('src'));
    const min = dinheiro(text($c.find('.preco-imovel').first()));
    const datas = text($c.find('.info-imovel-4').first()) || text($c.find('.info-imovel-3').last());
    const lot = canon({ host, id, url: abs(base, href)!, titulo, foto, min, fim: dataBr(datas), auctioneer: 'Leiloaria Smart', categoria: text($c.find('.info-imovel-1').first()) });
    if (lot) lots.push(lot);
  });
  return { lots, fetched: $('.caixa-imoveis').length, status: r.status };
}

async function coletarLaraForster(limit: number): Promise<{ lots: CanonicalLot[]; fetched: number; status: number }> {
  const host = 'leiloeslaraforster.com.br';
  const base = `https://${host}`;
  const r = await fetchText(`${base}/`, { headers: { 'user-agent': UA }, gapMs: 1100 });
  const $ = cheerio.load(r.body);
  const lots: CanonicalLot[] = [];
  $('a.bt_leilao_home').each((_, el) => {
    if (lots.length >= limit) return;
    const $c = $(el);
    const href = $c.attr('href');
    const id = href?.split('/').pop();
    const titulo = text($c.find('h5').first()).replace(/^Leil[ãa]o\s*\d+[-–]?/i, '');
    if (!href || !id || !titulo) return;
    const foto = abs(base, $c.find('img').first().attr('src'));
    const datas = text($c.find('h6').first());
    const lot = canon({ host, id, url: abs(base, href)!, titulo, foto, status: text($c.find('.tag').first()), fim: dataBr(datas.split(/2ª Praça:/i).pop()), auctioneer: 'Lara Forster Leilões' });
    if (lot) lots.push(lot);
  });
  return { lots, fetched: $('a.bt_leilao_home').length, status: r.status };
}

async function coletarArremate(limit: number): Promise<{ lots: CanonicalLot[]; fetched: number; status: number }> {
  const host = 'arremate.lel.br';
  const base = `https://www.${host}`;
  const paths = ['/leiloes-judiciais', '/leilao/judiciais-trt4'];
  const lots: CanonicalLot[] = [];
  let fetched = 0, status = 0;
  const vistos = new Set<string>();
  for (const path of paths) {
    if (lots.length >= limit) break;
    const r = await fetchText(`${base}${path}`, { headers: { 'user-agent': UA }, gapMs: 1100 });
    status = r.status;
    if (r.status !== 200) continue;
    const $ = cheerio.load(r.body);
    const cards = $('.meu-card').toArray();
    fetched += cards.length;
    for (const el of cards) {
      if (lots.length >= limit) break;
      const $c = $(el);
      const href = $c.find('a[href*="detalhes/"]').last().attr('href');
      const id = href?.match(/detalhes\/(\d+)/)?.[1];
      if (!href || !id || vistos.has(id)) continue;
      vistos.add(id);
      const titulo = text($c.find('.titulo-item').last()) || $c.find('img').attr('alt') || '';
      const foto = abs(base, $c.find('img.img-card').first().attr('src'));
      const min = dinheiro(text($c.find('.card-label').filter((_, x) => /Lance M[ií]nimo/i.test($(x).text())).parent().find('.card-value').first()));
      const atual = dinheiro(text($c.find('.valor').first()));
      const fimTxt = text($c.find('.card-label').filter((_, x) => /Encerramento/i.test($(x).text())).parent().find('.card-value').first());
      const lot = canon({ host, id, url: abs(base, href)!, titulo, foto: foto?.includes('semfoto') ? null : foto, status: text($c.find('[class*="status-"]').first()), fim: dataBr(fimTxt), min, atual, auctioneer: 'Arremate LEL' });
      if (lot) lots.push(lot);
    }
  }
  return { lots, fetched, status };
}

async function coletarRoiSoft(limit: number): Promise<{ lots: CanonicalLot[]; fetched: number; status: number }> {
  const tenants = [
    { host: 'caiapoleiloes.com.br', site: 'https://www.caiapoleiloes.com.br', api: 'https://www.caiapoleiloes.com.br', nome: 'Caiapó Leilões' },
    { host: 'norteleiloes.com.br', site: 'https://www.norteleiloes.com.br', api: 'https://www.sistema.norteleiloes.com.br', nome: 'Norte Leilões' },
  ];
  const lots: CanonicalLot[] = [];
  let fetched = 0, status = 0;
  for (const t of tenants) {
    if (lots.length >= limit) break;
    let r;
    try {
      r = await fetchJson<any>(`${t.api}/lotes/listar-dados?pagina=1&porPagina=40&filters=false&api=true`, {
        headers: { 'user-agent': UA, referer: `${t.site}/` }, gapMs: 1100,
      });
    } catch {
      continue;
    }
    status = r.status;
    const itens = Array.isArray(r.data?.dados) ? r.data.dados : [];
    fetched += itens.length;
    for (const l of itens) {
      if (lots.length >= limit) break;
      const id = String(l.LEL_ID ?? '').trim();
      const titulo = String(l.titulo ?? l.descricao ?? '').trim();
      if (!id || !titulo) continue;
      const foto = l.fotos?.[0]?.imgUrl_285x220 ?? l.fotos?.[0]?.imgUrl ?? l.imgUrl_285x220 ?? l.imgUrl ?? null;
      const url = l.urlLote && String(l.urlLote).startsWith('http') ? String(l.urlLote) : `${t.site}/lote/${id}`;
      const situacao = `${l.LEL_SITUACAO ?? ''} ${l.LEI_SITE_SITUACAO ?? ''}`;
      const valor = dinheiro(l.valorLance);
      const lot = canon({
        host: t.host, id, url, titulo, foto, status: situacao, fim: dataRoi(l.LED_DIA_F),
        min: valor, atual: /LANCE|ARREMATADO/i.test(String(l.LEL_SITUACAO ?? '')) ? valor : null,
        auctioneer: t.nome, categoria: l.LET_NOME ?? null,
      });
      if (lot) lots.push(lot);
    }
  }
  return { lots, fetched, status };
}

export const docxhtml: Connector = {
  def: {
    id: 'docxhtml',
    name: 'Leiloeiros DOCX - HTML/API',
    platform: 'HTML/API curado dos DOCX estaduais',
    method: 'html',
    tier: 3,
    siteUrl: 'https://www.centralsuldeleiloes.com.br',
    notes: 'Conector geral para sites dos DOCX que não compartilham uma plataforma já suportada, com parsers curados por domínio.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const lots: CanonicalLot[] = [];
    let fetched = 0, skipped = 0, httpStatus = 0;
    // Benedetto já tem conector próprio (`benedetto`). Aqui ficam só os sites
    // sem plataforma compartilhada já existente.
    const coletores = [coletarCentral, coletarCristiano, coletarLeiloariaSmart, coletarLaraForster, coletarArremate, coletarRoiSoft];
    const cota = Math.max(10, Math.ceil(limit / coletores.length));
    for (const coleta of coletores) {
      if (lots.length >= limit) break;
      try {
        const r = await coleta(Math.min(cota, limit - lots.length));
        httpStatus ||= r.status;
        fetched += r.fetched;
        lots.push(...r.lots);
        skipped += Math.max(0, r.fetched - r.lots.length);
      } catch {
        // Um tenant fora do ar não derruba os demais.
      }
    }
    return { lots, fetched, skipped, httpStatus };
  },
};
