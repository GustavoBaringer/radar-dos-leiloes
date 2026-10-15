import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot, LotStatus } from '../core/types.js';
import { query } from '../core/db.js';
import { filterTenantPopulation } from './tenant-scheduler.js';
import { classifyAsset, classifySeller, looksLikeCollectible, looksLikePart, parseTitle } from '../core/normalize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const scope = /im[oó]vel|apartamento|casa|terreno|sala|loja|galp[aã]o|fazenda|rural|ve[ií]culo|carro|moto|caminh[aã]o|ônibus|onibus|máquina|maquina|equipamento/i;
const clean = (v: string) => v.replace(/\s+/g, ' ').trim();
const date = (v: string) => {
  const m = v.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})h?/);
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`) : null;
};
function status(v: string, end: Date | null): LotStatus {
  if (/vendid/i.test(v)) return 'vendido';
  if (/aberto para lances/i.test(v)) return 'aberto';
  if (end && end.getTime() < Date.now()) return 'encerrado';
  return end ? 'agendado' : 'sem_data';
}
export function parseMsisPrincipal(html: string, host: string): CanonicalLot[] {
  const $ = cheerio.load(html), lots: CanonicalLot[] = [];
  $('[id^="divAnuncio1_"]').each((_, el) => {
    const card = $(el), text = clean(card.text());
    const id = card.attr('onclick')?.match(/abrirDetalhesLeilao\('([^']+)'/)?.[1];
    const title = clean(card.find('.Anuncio1_tit').text());
    const description = clean(card.find('.Anuncio1_descr').text());
    const state = card.find('input[value]').last().attr('value') ?? '';
    if (!id || !title || !scope.test(`${title} ${description}`) || looksLikePart(title) || looksLikeCollectible(title)) return;
    const dates = card.find('.Anuncio1_data').map((_, e) => date(clean($(e).text()))).get().filter((v): v is Date => v !== null);
    const end = dates.at(-1) ?? null, parsed = parseTitle(title), cls = classifyAsset(title, description, null);
    lots.push({ sourceId: 'msis', externalId: `${host}:${id}`, lotUrl: `https://www.${host}/Leilao.asp?zz=${id}`,
      titleRaw: title, brand: parsed.brand, model: parsed.model, yearMake: parsed.yearMake, yearModel: parsed.yearModel,
      assetType: cls.assetType, vehicleType: cls.vehicleType, closingModel: 'pregao_em_horario', auctionStartUtc: dates[0] ?? null, auctionEndUtc: end,
      sourceTz: 'America/Sao_Paulo', status: status(state || text, end), sellerType: classifySeller(null) as any,
      photos: card.find('img').map((_, e) => new URL($(e).attr('src') ?? '', `https://www.${host}/`).href).get().filter(Boolean),
      raw: { description, state, code: clean(card.find('.Anuncio1_cod').text()) }, });
  });
  return lots;
}
async function tenants(tenant?: string) {
  const rows = await query<{domain:string}>(`SELECT domain FROM discovered_sites WHERE platform='msis' AND http_status=200`);
  const population = rows.map(r => r.domain);
  if (!tenant) return population;
  const selected = filterTenantPopulation(population, tenant);
  if (!selected.length) throw new Error(`single-tenant '${tenant}' fora da população MSIS`);
  return selected;
}
export const msis: Connector = { def: { id:'msis', name:'MSIS Leilões', platform:'MSIS', method:'html', tier:3, siteUrl:'https://www.msis.com.br', notes:'ASP white-label: Principal.asp expõe os cards; Leilao.asp é o detalhe público.' },
  async collect({limit, tenant}): Promise<CollectResult> { const lots: CanonicalLot[]=[]; let fetched=0, skipped=0, httpStatus=0;
    for (const host of await tenants(tenant)) { const r=await fetchText(`https://www.${host}/Principal.asp`, {headers:{'user-agent':UA}, gapMs:1100}); httpStatus=r.status; if(r.status!==200) continue; const cards=parseMsisPrincipal(r.body,host); fetched+=cards.length; lots.push(...cards.slice(0,Math.max(0,limit-lots.length))); skipped += Math.max(0, cards.length - Math.max(0,limit-lots.length)); if(lots.length>=limit) break; }
    return {lots,fetched,skipped,httpStatus};
  } };
