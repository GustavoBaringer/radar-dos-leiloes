import type { SearchParams } from './repo.js';

export class BoundedInputError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BoundedInputError';
  }
}

const fail = (message: string): never => { throw new BoundedInputError(message); };
const objectRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(message);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail(message);
  return value as Record<string, unknown>;
};

/**
 * Fastify's default querystring parser creates its query dictionary with an
 * empty, null-rooted prototype. Accept that one additional structural shape
 * only at the HTTP search boundary, then copy own data properties onto a null
 * prototype so inherited values/accessors can never participate in parsing.
 */
function searchInputRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(message);
  try {
    const proto = Object.getPrototypeOf(value);
    const fastifyQueryPrototype =
      proto !== null && typeof proto === 'object' &&
      Object.getPrototypeOf(proto) === null && Reflect.ownKeys(proto).length === 0;
    if (proto !== Object.prototype && proto !== null && !fastifyQueryPrototype) return fail(message);

    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return fail(message);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(message);
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return fail(message);
  }
}

const SEARCH_KEYS = new Set([
  'q', 'uf', 'status', 'sellerType', 'sourceId', 'auctioneer', 'seller', 'assetType',
  'vehicleType', 'propertyType', 'city', 'priceMin', 'priceMax', 'yearMin', 'yearMax',
  'onlyWithDate', 'onlyWithPhoto', 'docType', 'endsWithin', 'belowAppraisal', 'place',
  'includeEnded', 'sort', 'page', 'pageSize',
]);
const LIST_KEYS = new Set([
  'uf', 'status', 'sellerType', 'sourceId', 'auctioneer', 'seller', 'vehicleType',
  'propertyType', 'city', 'docType',
]);
const STATUS = new Set(['aberto', 'agendado', 'sem_data', 'encerrado', 'vendido']);
const ASSET = new Set(['veiculo', 'imovel', 'outro']);
const SORT = new Set(['ending_soon', 'price_asc', 'price_desc', 'recent', 'discount']);
const UF = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);
const ALERT_FILTER_KEYS = new Set([
  'assetType', 'vehicleType', 'uf', 'sourceId', 'sellerType', 'auctioneer', 'priceMin',
  'priceMax', 'yearMin', 'yearMax', 'onlyWithPhoto', 'docType', 'belowAppraisal',
]);

function scalar(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return fail(`Parâmetro ${name} inválido.`);
  return value;
}

function list(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = Array.isArray(value) ? value : [value];
  if (parts.some((part) => typeof part !== 'string')) return fail(`Filtro ${name} inválido.`);
  const values = (parts as string[]).flatMap((part) => part.split(',')).map((part) => part.trim()).filter(Boolean);
  if (values.length > 20) return fail(`Filtro ${name} aceita no máximo 20 valores.`);
  if (values.some((part) => part.length > 100)) return fail(`Cada valor de ${name} aceita no máximo 100 caracteres.`);
  return values;
}

function strictInteger(value: unknown, name: string, min: number, max: number, fallback?: number): number | undefined {
  if (value === undefined || value === '') return fallback;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) n = Number(value);
  else return fail(`Parâmetro ${name} deve ser inteiro decimal.`);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fail(`Parâmetro ${name} fora do intervalo permitido.`);
  return n;
}

function decimal(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^(?:\d+)(?:\.\d+)?$/.test(value)) n = Number(value);
  else return fail(`Parâmetro ${name} deve ser decimal não negativo.`);
  if (!Number.isFinite(n) || n < 0) return fail(`Parâmetro ${name} deve ser decimal não negativo.`);
  return n;
}

function booleanValue(value: unknown, name: string, internal = false): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (internal) return fail(`Parâmetro ${name} inválido.`);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`Parâmetro ${name} deve ser true ou false.`);
}

function enumValue<T extends string>(value: unknown, name: string, allowed: Set<string>): T | undefined {
  const v = scalar(value, name);
  if (v === undefined || v === '') return undefined;
  if (!allowed.has(v)) return fail(`Parâmetro ${name} inválido.`);
  return v as T;
}

function validatePlace(value: unknown): string | undefined {
  const place = scalar(value, 'place')?.trim();
  if (!place) return undefined;
  const parts = place.split(';');
  if (parts.length > 20 || parts.some((part) => !part || part.length > 100)) return fail('Parâmetro place excede os limites permitidos.');
  for (const part of parts) {
    if (part.startsWith('c:')) {
      const match = /^c:([^/;]{1,96})\/([A-Z]{2})$/.exec(part);
      const cityKey = match?.[1];
      if (!match || !cityKey || cityKey.trim() !== cityKey || cityKey !== cityKey.toUpperCase()
        || !/^[\p{L}\p{N} .,'()&-]+$/u.test(cityKey) || !UF.has(match[2])) {
        return fail('Parâmetro place deve identificar cidade e UF válidas.');
      }
    } else {
      const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(part);
      if (!match) return fail('Parâmetro place deve conter coordenadas válidas.');
      const lat = Number(match[1]), lon = Number(match[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return fail('Parâmetro place deve conter coordenadas válidas.');
      }
    }
  }
  return place;
}

function parseSearch(value: unknown, internal: boolean): SearchParams {
  const q = internal ? (value as SearchParams).q : undefined;
  const row = internal ? (value as SearchParams) as Record<string, unknown> : searchInputRecord(value, 'Parâmetros de busca inválidos.');
  if (!internal) {
    for (const key of Object.keys(row)) if (!SEARCH_KEYS.has(key)) return fail('Parâmetro de busca desconhecido.');
  }
  const qValue = internal ? q : scalar(row.q, 'q');
  if (qValue !== undefined && typeof qValue !== 'string') return fail('Parâmetro q inválido.');
  if (typeof qValue === 'string' && qValue.length > 200) return fail('A busca aceita no máximo 200 caracteres.');

  const multi: Record<string, string[] | undefined> = {};
  for (const key of LIST_KEYS) multi[key] = list(row[key], key);
  if (multi.status?.some((item) => !STATUS.has(item))) return fail('Filtro status inválido.');
  const assetType = enumValue(row.assetType, 'assetType', ASSET);
  const sort = enumValue<'ending_soon' | 'price_asc' | 'price_desc' | 'recent' | 'discount'>(row.sort, 'sort', SORT);
  const endsWithin = enumValue<'hoje' | '7d'>(row.endsWithin, 'endsWithin', new Set(['hoje', '7d']));
  const priceMin = decimal(row.priceMin, 'priceMin'), priceMax = decimal(row.priceMax, 'priceMax');
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) return fail('priceMin não pode superar priceMax.');
  const yearMin = strictInteger(row.yearMin, 'yearMin', 0, 9999);
  const yearMax = strictInteger(row.yearMax, 'yearMax', 0, 9999);
  if (yearMin !== undefined && yearMax !== undefined && yearMin > yearMax) return fail('yearMin não pode superar yearMax.');
  const page = strictInteger(row.page, 'page', 1, 100, 1)!;
  const pageSize = strictInteger(row.pageSize, 'pageSize', 1, 100, 24)!;

  return {
    q: qValue as string | undefined,
    uf: multi.uf, status: multi.status, sellerType: multi.sellerType, sourceId: multi.sourceId,
    auctioneer: multi.auctioneer, seller: multi.seller, assetType,
    vehicleType: multi.vehicleType, propertyType: multi.propertyType, city: multi.city,
    priceMin, priceMax, yearMin, yearMax,
    onlyWithDate: booleanValue(row.onlyWithDate, 'onlyWithDate', internal),
    onlyWithPhoto: booleanValue(row.onlyWithPhoto, 'onlyWithPhoto', internal),
    docType: multi.docType, endsWithin, belowAppraisal: booleanValue(row.belowAppraisal, 'belowAppraisal', internal),
    place: validatePlace(row.place), includeEnded: booleanValue(row.includeEnded, 'includeEnded', internal),
    sort, page, pageSize,
  };
}

/** Parses a raw HTTP query object without coercing objects or duplicate scalars. */
export function parseSearchInput(query: unknown): SearchParams {
  return parseSearch(query, false);
}

/** Revalidates typed callers at the repository boundary, independently of HTTP. */
export function normalizeSearchParams(input: SearchParams): SearchParams {
  return parseSearch(input, true);
}

export function parsePagination(page?: unknown, pageSize?: unknown): { page: number; pageSize: number; offset: number } {
  const normalized = parseSearch({ page, pageSize }, false);
  return { page: normalized.page!, pageSize: normalized.pageSize!, offset: (normalized.page! - 1) * normalized.pageSize! };
}

export function safePositiveId(value: unknown, options: { allowString?: boolean } = {}): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (options.allowString === false || typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function paginateRows<T>(rows: readonly T[], page: number, pageSize: number): { items: T[]; page: number; pageSize: number; hasMore: boolean } {
  // Callers query exactly this page with LIMIT pageSize+1; never load/slice the full table here.
  return { items: rows.slice(0, pageSize), page, pageSize, hasMore: rows.length > pageSize };
}

export interface ValidatedAlertInput {
  label?: string;
  q?: string;
  filters?: Record<string, string | number | boolean | string[]>;
  channels?: string[];
  email?: string | null;
}

/** Validates new/edit alert requests against the fields the alert matcher consumes. */
export function ValidateAlertInput(value: unknown, options: { edit?: boolean } = {}): ValidatedAlertInput {
  const body = objectRecord(value, 'Corpo do alerta inválido.');
  const allowedKeys = options.edit
    ? new Set(['label', 'channels', 'email'])
    : new Set(['label', 'q', 'filters', 'channels', 'email']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return fail('Corpo do alerta contém campos inválidos.');

  const label = scalar(body.label, 'label')?.trim();
  if (label !== undefined && (!label || label.length > 80)) return fail('label deve ter de 1 a 80 caracteres.');
  const q = scalar(body.q, 'q')?.trim();
  if (q !== undefined && q.length > 200) return fail('A busca do alerta aceita no máximo 200 caracteres.');

  let filters: Record<string, string | number | boolean | string[]> | undefined;
  if (body.filters !== undefined) {
    const rawFilters = objectRecord(body.filters, 'Filtros do alerta inválidos.');
    if (Object.keys(rawFilters).some((key) => !ALERT_FILTER_KEYS.has(key))) return fail('Filtros do alerta contêm campos não suportados.');
    filters = {};
    for (const [key, raw] of Object.entries(rawFilters)) {
      if (key === 'assetType') filters[key] = enumValue(raw, key, ASSET)!;
      else if (['priceMin', 'priceMax'].includes(key)) filters[key] = decimal(raw, key)!;
      else if (['yearMin', 'yearMax'].includes(key)) filters[key] = strictInteger(raw, key, 0, 9999)!;
      else if (['onlyWithPhoto', 'belowAppraisal'].includes(key)) filters[key] = booleanValue(raw, key, true)!;
      else {
        const name = key === 'uf' ? 'uf' : key;
        const values = list(raw, name)!;
        if (key === 'uf' && values.some((uf) => !UF.has(uf.toUpperCase()))) return fail('Filtro uf do alerta inválido.');
        filters[key] = Array.isArray(raw) ? values : values.join(',');
      }
    }
  }

  const channelsRaw = body.channels;
  let channels = ['sino'];
  if (channelsRaw !== undefined) {
    if (!Array.isArray(channelsRaw) || channelsRaw.length > 3 || channelsRaw.some((c) => typeof c !== 'string')) return fail('Canais do alerta inválidos.');
    const values = channelsRaw as string[];
    if (!values.length || new Set(values).size !== values.length || values.some((c) => !['sino', 'push', 'email'].includes(c))) {
      return fail('Canais do alerta inválidos.');
    }
    channels = values;
  }
  let email: string | null | undefined;
  if (body.email === null) email = null;
  else if (body.email !== undefined) {
    email = scalar(body.email, 'email')!.trim();
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('E-mail do alerta inválido.');
  }
  if (channels.includes('email') && !email) return fail('Canal email exige endereço válido.');
  if (!options.edit && !q && !Object.keys(filters ?? {}).length) return fail('Alerta exige termo de busca ou ao menos um filtro.');
  return { label, q, filters, channels, email };
}
