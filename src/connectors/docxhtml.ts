import * as cheerio from 'cheerio';
import { fetchJson, fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { parseTitle, classifySeller, looksLikePart, classifyAsset, fold } from '../core/normalize.js';
import { throwIfCancelled } from '../infra/collection/collection-cancellation.js';
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

/**
 * Evidência nomeada, não dedução.
 *
 * A API Roisoft não manda categoria (`LET_NOME` veio null nos 102 itens do
 * Leilões Brasil medidos em 13/10/2026), então `classifyAsset` cai no padrão
 * final `veiculo/carro` e chamaria de carro "4533 - LOTE - COM 378 M2",
 * "M-4391 - MISTO - COM ÁREA DE 268,32m²" e "65 UNDS. DE MESAS E CADEIRAS".
 * A versão anterior tinha o problema inverso: só reconhecia 12 marcas, então
 * "ONIBUS MARCOPOLO", "TRATOR LS U80R", "CHACARA" e "SOBRADO" caíam em
 * `outro` e 62 de 102 lotes reais foram descartados.
 *
 * Veículo exige palavra que o nomeie (genérico ou marca). Imóvel usa os
 * marcadores de área/matrícula. O que não é nenhum dos dois fica `outro` —
 * some da vitrine em vez de virar carro.
 */
export function tipo(titulo: string, cat?: string | null): 'veiculo' | 'imovel' | 'outro' {
  const t = fold(`${titulo} ${cat ?? ''}`);
  if (/\b(imove|imoveis|apartamento|casa|sobrado|kitnet|kitinete|terreno|gleba|chacara|sitio|rural|urbano|loteamento|galpao|sala|loja|predio|vaga|matricula|area (com|construida|total))\b/.test(t)) return 'imovel';
  // Genéricos novos ("ônibus", "trator", "escavadeira") + as marcas que a
  // versão anterior já acertava. "fazenda" fica de fora de propósito: no
  // vlance "Honda/NXR 150 - Fazenda Nova/GO" é moto, não imóvel.
  if (/\b(veiculo|automovel|carro|moto|motocicleta|trator|trilha|retroescavadeira|escavadeira|empilhadeira|colheitadeira|motoniveladora|niveladora|carregadeira|onibus|microonibus|caminhao|caminhonete|utilitario|camioneta|carreta|reboque|embarcacao|lancha|barco|navio|fiat|ford|vw|volks|honda|toyota|gm|chevrolet|hyundai|renault|peugeot|yamaha|citroen|bmw|nissan|mitsubishi|volvo|scania|iveco|mercedes|mmc)\b/.test(t)) return 'veiculo';
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

/** Tenants cujo contrato Roisoft foi medido por resposta pública da própria API. */
export const ROISOFT_HOSTS = new Set([
  'caiapoleiloes.com.br', 'leiloesbrasil.com.br', 'sancarleiloes.com.br', 'leiloeiroeduardo.com.br',
]);

async function coletarRoiSoft(limit: number, soHost?: string): Promise<{ lots: CanonicalLot[]; fetched: number; status: number; note?: string }> {
  // O Norte Leilões saiu daqui: a API dele exige POST + Origin/Referer (GET
  // devolve 403 medido em 13/10/2026) e hoje tem coletor próprio (coletarNorte).
  // Contrato Roisoft medido em 13/10/2026 nas 4 homes (mesma meta Author=Roisoft,
  // mesma rota /lotes/listar-dados, mesma forma {dados,dadosPaginacao}). A API
  // ignora porPagina=40 e devolve 20 por página — ler só pagina=1 truncava o
  // catálogo em 20 de 102 (Leilões Brasil) e em 20 de 22 (Caiapó).
  const tenants = [
    { host: 'caiapoleiloes.com.br', site: 'https://www.caiapoleiloes.com.br', api: 'https://www.caiapoleiloes.com.br', nome: 'Caiapó Leilões' },
    { host: 'leiloesbrasil.com.br', site: 'https://www.leiloesbrasil.com.br', api: 'https://www.leiloesbrasil.com.br', nome: 'Leilões Brasil' },
    { host: 'sancarleiloes.com.br', site: 'https://www.sancarleiloes.com.br', api: 'https://www.sancarleiloes.com.br', nome: 'Sancar Leilões' },
    { host: 'leiloeiroeduardo.com.br', site: 'https://www.leiloeiroeduardo.com.br', api: 'https://www.leiloeiroeduardo.com.br', nome: 'Leiloeiro Eduardo' },
  ].filter(t => !soHost || t.host === soHost);
  const lots: CanonicalLot[] = [];
  let fetched = 0, status = 0;
  const parciales: string[] = [];
  for (const t of tenants) {
    if (lots.length >= limit) break;
    // Sem this.ponto de parada explícito, a paginação nunca terminaria; o teto
    // é de 40 páginas porque nenhum tenant medido passou de 6.
    const MAX_PAGINAS = 40;
    let pagina = 1;
    let pageCount = 1;
    let itensVistos = 0;
    do {
      if (lots.length >= limit) break;
      let r;
      try {
        r = await fetchJson<any>(`${t.api}/lotes/listar-dados?pagina=${pagina}&porPagina=40&filters=false&api=true`, {
          headers: { 'user-agent': UA, referer: `${t.site}/` }, gapMs: 1100,
        });
      } catch {
        parciales.push(`${t.host}: pagina ${pagina} falhou`);
        break;
      }
      status = r.status;
      const itens = Array.isArray(r.data?.dados) ? r.data.dados : [];
      const pag = r.data?.dadosPaginacao ?? {};
      pageCount = Number(pag.pageCount ?? 1) || 1;
      fetched += itens.length;
      itensVistos += itens.length;
      if (!itens.length && pagina <= pageCount) parciales.push(`${t.host}: pagina ${pagina} de ${pageCount} veio vazia`);
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
      pagina += 1;
    } while (pagina <= pageCount && pagina <= MAX_PAGINAS);
    if (itensVistos === 0) parciales.push(`${t.host}: API respondeu sem nenhum lote no momento`);
    else if (lots.length >= limit) parciales.push(`${t.host}: limite ${limit} atingido em ${itensVistos} itens lidos`);
    else if (pagina > MAX_PAGINAS) parciales.push(`${t.host}: parou no teto de ${MAX_PAGINAS} páginas`);
  }
  return { lots, fetched, status, note: parciales.length ? parciales.join('; ') : undefined };
}

/* ------------------------------------------------------------------ *
 * Norte Leilões (norteleiloes.com.br) — SPA Next.js em /lotes.
 *
 * O HTML server-side não mapeia nada ("0 Lotes encontrados / Aguarde
 * Carregando..."). O contrato real foi medido nos chunks JS que a própria
 * página entrega (0fnwbp609eb9e.js):
 *   POST https://www.sistema.norteleiloes.com.br/lotes/listar-dados
 *        ?pagina={N}&porPagina=12&api=true
 *   Content-Type: application/x-www-form-urlencoded, body "pagina={N}&porPagina=12"
 * Sem Origin/Referer do site a API devolve 403 (medido em 13/10/2026); são os
 * headers que o próprio browser envia, não um bypass. GET também 403 (medido).
 * Resposta: { dados: [...], dadosPaginacao: { pageCount, totalItemCount, ... } }.
 * A lista NÃO traz avaliação nem lance mínimo; `valorLance` vem em formato
 * americano ("146000.00") e só quando há lances (LEL_COUNT_LANCES > 0).
 */
export const NORTE = {
  host: 'norteleiloes.com.br',
  site: 'https://www.norteleiloes.com.br',
  api: 'https://www.sistema.norteleiloes.com.br',
  nome: 'Norte Leilões',
};

/** valorLance da API é americano ("146000.00"); dinheiro() espera "1.234,00". */
function norteValor(v: unknown): number | null {
  if (v == null || v === '' || v === false) return null;
  const s = String(v).trim();
  const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : dinheiro(s);
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * LED_DIA_F ("HOJE, 13/OUT/2026 - 10h00" / "AMANHÃ, 14/OUT/2026 - 10h30" /
 * "QUI, 15/OUT/2026 - 09h30") traz a data ABSOLUTA mesmo quando rotulada como
 * relativa; o rótulo "HOJE"/"AMANHÃ" é só apresentação. `confere` valida o
 * rótulo contra o relógio em America/Sao_Paulo (UTC-3, sem DST desde 2019 —
 * o parser fixa -03:00, o mesmo offset que o resto do repo usa).
 */
export function norteData(txt?: string | null, agora: Date = new Date()): { date: Date | null; relativo: 'HOJE' | 'AMANHÃ' | null; confere: boolean | null } {
  const s = String(txt ?? '').trim();
  const m = s.match(/^\s*(HOJE|AMANH[ÃA])/i);
  const relativo = m ? (m[1].toUpperCase().startsWith('HOJE') ? 'HOJE' as const : 'AMANHÃ' as const) : null;
  const date = dataRoi(s) ?? dataBr(s);
  let confere: boolean | null = null;
  if (date && relativo) {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
    confere = fmt.format(date) === fmt.format(relativo === 'HOJE' ? agora : new Date(agora.getTime() + 24 * 3600 * 1000));
  }
  return { date, relativo, confere };
}

/**
 * Status só com base no que a fonte publica: LEL_SITUACAO decide, data
 * desempata. "LIBERADO_LEILAO" = lote liberado no leilão (aceitando lances,
 * medido com LEL_COUNT_LANCES > 0 mesmo antes da data); "AG_PAGAMENTO" =
 * arrematado aguardando pagamento; "NAO_ARREMATADO" com data futura ainda vai
 * a praça, com data passada foi a praça e não vendeu.
 */
export function statusNorte(lelSituacao: string, fim: Date | null, agora: Date = new Date()): LotStatus {
  if (lelSituacao === 'AG_PAGAMENTO') return 'vendido';
  if (lelSituacao === 'LIBERADO_LEILAO') return 'aberto';
  if (lelSituacao === 'NAO_ARREMATADO') return fim && fim.getTime() > agora.getTime() ? 'agendado' : 'encerrado';
  return statusDe(lelSituacao, fim);
}

export interface NorteDescarte { id: string; titulo: string; motivo: 'sucata' | 'titulo_peca' | 'tipo_peca' }

/**
 * Mapeia UMA página da lista. Dedup por LEL_ID via `vistos` (compartilhado
 * entre páginas: a fonte pode repetir item no corte da paginação). Schema
 * inesperado (item sem LEL_ID/titulo, payload sem dados) não derruba a página.
 */
export function parseNortePage(
  payload: { dados?: unknown; dadosPaginacao?: { pageCount?: unknown; totalItemCount?: unknown } } | null | undefined,
  opts: { vistos: Set<string>; limite: number; agora?: Date },
): { lots: CanonicalLot[]; descartados: NorteDescarte[]; itens: number; pageCount: number | null; totalItemCount: number | null } {
  const dados = Array.isArray(payload?.dados) ? (payload!.dados as unknown[]) : [];
  const pag = payload?.dadosPaginacao ?? null;
  const pageCountNum = Number((pag as any)?.pageCount);
  const totalNum = Number((pag as any)?.totalItemCount);
  const agora = opts.agora ?? new Date();
  const lots: CanonicalLot[] = [];
  const descartados: NorteDescarte[] = [];
  for (const item of dados) {
    const l = (item ?? {}) as Record<string, any>;
    const id = String(l.LEL_ID ?? '').trim();
    const titulo = String(l.titulo ?? l.descricao ?? '').trim();
    if (!id || !titulo) continue;
    if (opts.vistos.has(id)) continue;
    opts.vistos.add(id);
    if (lots.length >= opts.limite) continue;
    // Exclusão explícita: sucata/peça não é bem imóvel/veículo/máquina.
    if (l.vecSucata) { descartados.push({ id, titulo, motivo: 'sucata' }); continue; }
    if (/\b(pecas?|sucata)\b/.test(fold(titulo))) { descartados.push({ id, titulo, motivo: 'titulo_peca' }); continue; }
    const cls = classifyAsset(titulo, null);
    if (cls.vehicleType === 'peca') { descartados.push({ id, titulo, motivo: 'tipo_peca' }); continue; }

    const campoData: 'LED_DIA_F' | 'LED_DIA_F2' = norteData(l.LED_DIA_F).date ? 'LED_DIA_F' : 'LED_DIA_F2';
    const d = norteData(campoData === 'LED_DIA_F' ? l.LED_DIA_F : l.LED_DIA_F2);
    const fim = d.date;
    const parsed = cls.assetType === 'veiculo' ? parseTitle(titulo) : { brand: null, model: null, version: null, yearMake: null, yearModel: null };
    const local = campos.localDeTexto(titulo);
    const fotos = (Array.isArray(l.fotos) ? l.fotos : [])
      .map((f: any) => f?.imgUrl_285x220 ?? f?.imgUrl ?? null)
      .filter((u: any) => typeof u === 'string' && u.startsWith('http'));
    const fotoSolo = l.imgUrl_285x220 ?? l.imgUrl ?? null;
    const photos = fotos.length ? fotos : (typeof fotoSolo === 'string' && fotoSolo.startsWith('http') ? [fotoSolo] : []);
    lots.push({
      sourceId: 'docxhtml',
      externalId: `${NORTE.host}:${id}`,
      // urlLote vem null na lista; o detalhe público /lote/{LEL_ID} responde
      // 200 com o título no corpo (medido: 74772 → "JF-3090 - ALTAMIRA/PA...").
      lotUrl: `${NORTE.site}/lote/${id}`,
      auctioneerName: NORTE.nome,
      titleRaw: titulo,
      brand: parsed.brand,
      model: parsed.model,
      version: parsed.version,
      yearMake: parsed.yearMake,
      yearModel: parsed.yearModel,
      assetType: cls.assetType,
      vehicleType: cls.vehicleType,
      // A lista não publica categoria/documentação por lote: não inventar.
      sourceCategory: null,
      docType: null,
      closingModel: 'timer_por_lote',
      auctionStartUtc: null,
      auctionEndUtc: fim,
      sourceTz: 'America/Sao_Paulo',
      status: statusNorte(String(l.LEL_SITUACAO ?? ''), fim, agora),
      currentBid: norteValor(l.valorLance),
      // Sem lance mínimo nem avaliação na lista: ficam null, não zero.
      minBid: null,
      appraisal: null,
      sellerType: classifySeller(null) as any,
      city: local?.city ?? null,
      state: local?.uf ?? null,
      photos,
      raw: {
        tenant: NORTE.host,
        lelId: id,
        leilaoId: l.LEI_ID ?? null,
        lelSituacao: l.LEL_SITUACAO ?? null,
        leiSiteSituacao: l.LEI_SITE_SITUACAO ?? null,
        leiSiteTipo: l.LEI_SITE_TIPO ?? null,
        countLances: l.LEL_COUNT_LANCES ?? null,
        valorLanceFonte: l.valorLance ?? null,
        dataFonte: campoData,
        diaRelativo: d.relativo,
        diaRelativoConfere: d.confere,
      },
    });
  }
  return {
    lots,
    descartados,
    itens: dados.length,
    pageCount: Number.isFinite(pageCountNum) ? pageCountNum : null,
    totalItemCount: Number.isFinite(totalNum) ? totalNum : null,
  };
}

/** Varre a paginação completa (364 itens / 12 por página = 31 páginas), sequencial. */
export async function coletarNorte(
  limit: number,
  buscar: typeof fetchText = fetchText,
): Promise<{ lots: CanonicalLot[]; fetched: number; descartados: NorteDescarte[]; status: number; note?: string }> {
  const vistos = new Set<string>();
  const lots: CanonicalLot[] = [];
  const descartados: NorteDescarte[] = [];
  let fetched = 0, status = 0, note: string | undefined;
  let pagina = 1, pageCount = 1;
  do {
    throwIfCancelled();
    let r;
    try {
      r = await buscar(`${NORTE.api}/lotes/listar-dados?pagina=${pagina}&porPagina=12&api=true`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: NORTE.site,
          referer: `${NORTE.site}/lotes`,
        },
        body: `pagina=${pagina}&porPagina=12`,
        gapMs: 1100,
      });
    } catch (error) {
      throwIfCancelled();
      note = `Norte: falha de rede na página ${pagina}: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    status ||= r.status;
    if (r.status !== 200) { note = `Norte: HTTP ${r.status} na página ${pagina}`; break; }
    let payload: any;
    try { payload = JSON.parse(r.body); } catch { note = `Norte: resposta não-JSON na página ${pagina}`; break; }
    const res = parseNortePage(payload, { vistos, limite: limit - lots.length });
    fetched += res.itens;
    descartados.push(...res.descartados);
    lots.push(...res.lots);
    if (res.itens === 0) break;
    pageCount = res.pageCount ?? pagina;
    pagina += 1;
  } while (pagina <= pageCount && lots.length < limit);
  return { lots, fetched, descartados, status, note };
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
  async collect({ limit, tenant }): Promise<CollectResult> {
    if (tenant !== undefined) {
      if (tenant === NORTE.host) {
        const r = await coletarNorte(limit);
        return {
          lots: r.lots,
          fetched: r.fetched,
          skipped: Math.max(0, r.fetched - r.lots.length),
          httpStatus: r.status,
          ...(r.note ? { note: r.note } : {}),
        };
      }
      if (ROISOFT_HOSTS.has(tenant)) {
        const r = await coletarRoiSoft(limit, tenant);
        return {
          lots: r.lots,
          fetched: r.fetched,
          skipped: Math.max(0, r.fetched - r.lots.length),
          httpStatus: r.status,
          ...(r.note ? { note: r.note } : {}),
        };
      }
      if (tenant !== 'leiloeslaraforster.com.br') throw new Error(`Unreviewed docxhtml tenant: ${tenant}`);
      const r = await coletarLaraForster(limit);
      return { lots: r.lots, fetched: r.fetched, skipped: Math.max(0, r.fetched-r.lots.length), httpStatus: r.status };
    }
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
