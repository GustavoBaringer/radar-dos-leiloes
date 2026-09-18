import type { FacetRow, Facets } from './types';
import { LABEL_PROPERTY, LABEL_SELLER, LABEL_STATUS, LABEL_VEHICLE, SRC_LABEL } from './labels';

/**
 * As oito facetas de seleção múltipla.
 *
 * Não são `<select multiple>` de propósito: o nativo exige segurar Ctrl no
 * desktop e vira lista rolante no toque. Cada uma vira um componente com busca
 * interna, e o valor sai como 'SP,RJ'.
 *
 * Tipo de leilão (assetType) continua escolha única, e isso não é esquecimento:
 * a tela troca de rótulo, de filtros e de contagem conforme o bem, e "os dois
 * ao mesmo tempo" é justamente o estado sem filtro.
 */
export interface DefMulti {
  id: MultiId;
  titulo: string;
  vazio: string;
  plural: string;
  faceta: keyof Facets;
  fixas?: Record<string, string>;
  rotulo?: (v: string) => string;
}

export type MultiId =
  | 'status' | 'vehicleType' | 'propertyType' | 'uf'
  | 'city' | 'sellerType' | 'sourceId' | 'auctioneer' | 'seller';

export const MULTIS: DefMulti[] = [
  { id: 'vehicleType', titulo: 'Tipo de veículo', vazio: 'Todos', plural: 'tipos selecionados', faceta: 'vehicleTypes', fixas: LABEL_VEHICLE },
  { id: 'propertyType', titulo: 'Tipo de imóvel', vazio: 'Todos', plural: 'tipos selecionados', faceta: 'propertyTypes', fixas: LABEL_PROPERTY },
  { id: 'status', titulo: 'Situação', vazio: 'Todas', plural: 'situações selecionadas', faceta: 'statuses', fixas: LABEL_STATUS },
  { id: 'uf', titulo: 'Estado', vazio: 'Todos', plural: 'estados selecionados', faceta: 'states' },
  // A chave é sem acento ('SAO PAULO'); o rótulo vem pronto do servidor, que
  // escolhe a melhor grafia entre as que as fontes publicam.
  { id: 'city', titulo: 'Cidade', vazio: 'Todas', plural: 'cidades selecionadas', faceta: 'cities' },
  { id: 'sellerType', titulo: 'Origem do lote', vazio: 'Todas', plural: 'origens selecionadas', faceta: 'sellerTypes', fixas: LABEL_SELLER },
  { id: 'sourceId', titulo: 'Fonte', vazio: 'Todas', plural: 'fontes selecionadas', faceta: 'sources', rotulo: (v) => SRC_LABEL[v] ?? v },
  { id: 'auctioneer', titulo: 'Leiloeiro', vazio: 'Todos', plural: 'leiloeiros selecionados', faceta: 'auctioneers' },
  // Comitente é quem PÔS o bem em leilão (Caixa, Porto Seguro, um tribunal) —
  // pergunta diferente de "qual leiloeiro conduz". 87% dos lotes publicam.
  { id: 'seller', titulo: 'Comitente', vazio: 'Todos', plural: 'comitentes selecionados', faceta: 'sellers' },
];

export const MULTI_IDS = MULTIS.map((m) => m.id);
export const defDe = (id: MultiId) => MULTIS.find((m) => m.id === id)!;

/** Campos de valor único. Os de seleção múltipla vivem em MULTIS. */
export const CAMPOS_FILTRO = ['assetType', 'priceMin', 'priceMax', 'yearMin', 'yearMax'] as const;
export type CampoFiltro = (typeof CAMPOS_FILTRO)[number];

export interface EstadoBusca {
  q: string;
  assetType: string;
  priceMin: string;
  priceMax: string;
  yearMin: string;
  yearMax: string;
  sort: string;
  onlyWithDate: boolean;
  onlyWithPhoto: boolean;
  multi: Record<MultiId, string[]>;
  page: number;
  /** Grade (listagem) ou mapa. É uma forma de ver a MESMA busca, não outra tela. */
  vista: 'grade' | 'mapa';
  /** Ponto escolhido no mapa: 'lat,lon' ou 'c:CHAVECIDADE/UF'. */
  local: string;
}

export const ESTADO_VAZIO: EstadoBusca = {
  q: '', assetType: '', priceMin: '', priceMax: '', yearMin: '', yearMax: '',
  sort: 'ending_soon', onlyWithDate: false, onlyWithPhoto: false,
  multi: { status: [], vehicleType: [], propertyType: [], uf: [], city: [], sellerType: [], sourceId: [], auctioneer: [], seller: [] },
  page: 1,
  vista: 'grade',
  local: '',
};

/** Quantos filtros estão ativos — o número que aparece no botão do celular. */
export function contaFiltros(e: EstadoBusca): number {
  return (
    CAMPOS_FILTRO.filter((id) => e[id]).length +
    MULTI_IDS.reduce((t, id) => t + e.multi[id].length, 0) +
    (e.onlyWithDate ? 1 : 0) +
    (e.onlyWithPhoto ? 1 : 0)
  );
}

/** O que vai para /api/search. Inclui `page`; o rótulo da URL é outro (ver urlDoEstado). */
export function paramsDaBusca(e: EstadoBusca): string {
  const p = new URLSearchParams();
  if (e.q.trim()) p.set('q', e.q.trim());
  for (const id of CAMPOS_FILTRO) if (e[id]) p.set(id, e[id]);
  if (e.sort) p.set('sort', e.sort);
  for (const id of MULTI_IDS) if (e.multi[id].length) p.set(id, e.multi[id].join(','));
  if (e.onlyWithDate) p.set('onlyWithDate', 'true');
  if (e.onlyWithPhoto) p.set('onlyWithPhoto', 'true');
  if (e.local) p.set('place', e.local);
  p.set('page', String(e.page));
  return p.toString();
}

/**
 * A tela inteira cabe na URL: quem manda o link manda a busca junto.
 * Página 1, ordenação padrão e valores vazios ficam de fora para o link não
 * virar um paredão.
 */
export function urlDoEstado(e: EstadoBusca): string {
  const p = new URLSearchParams();
  if (e.q.trim()) p.set('q', e.q.trim());
  for (const id of CAMPOS_FILTRO) if (e[id]) p.set(id, e[id]);
  for (const id of MULTI_IDS) if (e.multi[id].length) p.set(id, e.multi[id].join(','));
  if (e.onlyWithDate) p.set('onlyWithDate', '1');
  if (e.onlyWithPhoto) p.set('onlyWithPhoto', '1');
  if (e.sort && e.sort !== 'ending_soon') p.set('sort', e.sort);
  if (e.vista === 'mapa') p.set('vista', 'mapa');
  if (e.local) p.set('local', e.local);
  if (e.page > 1) p.set('page', String(e.page));
  const qs = p.toString();
  return `/busca${qs ? `?${qs}` : ''}`;
}

/** Caminho inverso: a URL pinta a tela. Vale para link de fora e para o "voltar". */
export function estadoDaUrl(busca: string): EstadoBusca {
  const p = new URLSearchParams(busca);
  const e: EstadoBusca = { ...ESTADO_VAZIO, multi: { ...ESTADO_VAZIO.multi } };
  e.q = p.get('q') ?? '';
  // `tipo` é o apelido curto que a landing usa nos botões Veículos e Imóveis.
  const tipo = p.get('tipo');
  for (const id of CAMPOS_FILTRO) e[id] = p.get(id) ?? '';
  if (tipo === 'veiculo' || tipo === 'imovel') e.assetType = tipo;
  for (const id of MULTI_IDS) e.multi[id] = (p.get(id) ?? '').split(',').filter(Boolean);
  e.onlyWithDate = p.get('onlyWithDate') === '1';
  e.onlyWithPhoto = p.get('onlyWithPhoto') === '1';
  const sort = p.get('sort');
  e.sort = sort && ['ending_soon', 'discount', 'price_asc', 'price_desc', 'recent'].includes(sort) ? sort : 'ending_soon';
  e.vista = p.get('vista') === 'mapa' ? 'mapa' : 'grade';
  e.local = p.get('local') ?? '';
  e.page = Math.max(1, Number(p.get('page')) || 1);
  return e;
}

/** O rótulo de uma opção de faceta: o do servidor vence, depois o fixo, depois o valor cru. */
export function rotuloOpcao(def: DefMulti, linha: FacetRow): string {
  return linha.label ?? def.fixas?.[linha.value] ?? def.rotulo?.(linha.value) ?? linha.value;
}

/** Resumo no botão fechado: "Todos", o único escolhido, ou "N selecionados". */
export function resumoMulti(def: DefMulti, escolhidos: string[], rotulos: Record<string, string>): string {
  if (!escolhidos.length) return def.vazio;
  if (escolhidos.length === 1) {
    const v = escolhidos[0];
    return rotulos[v] ?? def.fixas?.[v] ?? def.rotulo?.(v) ?? v;
  }
  return `${escolhidos.length} ${def.plural}`;
}
