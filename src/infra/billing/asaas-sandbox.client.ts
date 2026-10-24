const API_BASE = 'https://api-sandbox.asaas.com/v3';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const PRICE = 69.9;

export type CheckoutCreated = { id: string; link: string; status: string };
export type PaymentSnapshot = {
  id: string; status: string; value: number; billingType: string;
  checkoutSession: string | null; subscription: string | null;
  confirmedDate?: string | null;
};
export type SubscriptionSnapshot = {
  id: string; status: string; value: number; cycle: string; checkoutSession: string | null;
};

export class AsaasRequestRejectedError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Asaas Sandbox request rejected (HTTP ${httpStatus})`);
    this.name = 'AsaasRequestRejectedError';
  }
}

export class AsaasCheckoutOutcomeUnknownError extends Error {
  constructor(readonly httpStatus: number | null = null) {
    super('Asaas Sandbox checkout outcome is unknown; reconcile before retrying');
    this.name = 'AsaasCheckoutOutcomeUnknownError';
  }
}

export class AsaasResponseError extends Error {
  constructor() {
    super('Invalid Asaas Sandbox response');
    this.name = 'AsaasResponseError';
  }
}

export class AsaasTransportError extends Error {
  constructor() {
    super('Asaas Sandbox transport failed');
    this.name = 'AsaasTransportError';
  }
}

const validId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const validResourceId = (value: unknown): value is string => validId(value) && value !== '.' && value !== '..';

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validOptionalId(value: unknown): value is string | null {
  return value == null || validId(value);
}

function canonicalDateOnly(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function nextDueDate(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid clock value');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function readJsonBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new AsaasResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AsaasResponseError();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))));
  } catch {
    throw new AsaasResponseError();
  }
}

export class AsaasSandboxClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(apiKey: string, options: { fetch?: typeof fetch; now?: () => Date } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey) || apiKey.length > 4096) {
      throw new TypeError('A valid Asaas Sandbox API key is required');
    }
    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async createCheckout(input: { attemptId: string; returnUrl: string; firstDueDate?: string }): Promise<CheckoutCreated> {
    if (!validId(input?.attemptId) || input.attemptId.length > 200) throw new TypeError('Invalid checkout attempt ID');
    if (typeof input.returnUrl !== 'string') throw new TypeError('Invalid checkout return URL');
    let returnUrl: URL;
    try { returnUrl = new URL(input.returnUrl); } catch { throw new TypeError('Invalid checkout return URL'); }
    if (input.returnUrl.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(input.returnUrl)
      || returnUrl.protocol !== 'https:' || returnUrl.username || returnUrl.password || returnUrl.hash) {
      throw new TypeError('Invalid checkout return URL');
    }
    let firstDueDate: string;
    if (input.firstDueDate === undefined) firstDueDate = nextDueDate(this.#now());
    else {
      const date = input.firstDueDate;
      if (!canonicalDateOnly(date)) throw new TypeError('Invalid first due date');
      firstDueDate = date;
    }
    const callbackUrl = returnUrl.toString();
    const body = {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      externalReference: input.attemptId,
      callback: { cancelUrl: callbackUrl, successUrl: callbackUrl, expiredUrl: callbackUrl },
      minutesToExpire: 60,
      items: [{ name: 'Assinatura Radar', description: 'Monthly subscription', quantity: 1, value: PRICE }],
      subscription: { cycle: 'MONTHLY', nextDueDate: firstDueDate },
    };
    let response: Response;
    try {
      response = await this.#request('/checkouts', { method: 'POST', body: JSON.stringify(body) });
    } catch {
      throw new AsaasCheckoutOutcomeUnknownError();
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw new AsaasCheckoutOutcomeUnknownError(response.status);
      }
      throw new AsaasRequestRejectedError(response.status);
    }
    let result: any;
    try { result = await readJsonBounded(response); } catch { throw new AsaasCheckoutOutcomeUnknownError(response.status); }
    if (!validId(result?.id) || typeof result?.link !== 'string' || typeof result?.status !== 'string'
      || !result.status || result.status.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(result.status)) {
      throw new AsaasCheckoutOutcomeUnknownError(response.status);
    }
    let link: URL;
    try { link = new URL(result.link); } catch { throw new AsaasCheckoutOutcomeUnknownError(response.status); }
    if (result.link.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(result.link)
      || link.origin !== 'https://sandbox.asaas.com' || link.username || link.password) throw new AsaasCheckoutOutcomeUnknownError(response.status);
    return { id: result.id, link: result.link, status: result.status };
  }

  async retrievePayment(id: string): Promise<PaymentSnapshot> {
    if (!validResourceId(id)) throw new TypeError('Invalid payment ID');
    const result = await this.#get(`/payments/${encodeURIComponent(id)}`);
    if (result?.id !== id || !validId(result?.id) || !requiredString(result?.status) || !Number.isFinite(result?.value)
      || result.value < 0 || !requiredString(result?.billingType)
      || !validOptionalId(result?.checkoutSession) || !validOptionalId(result?.subscription)) throw new AsaasResponseError();
    const confirmedDate = canonicalDateOnly(result?.confirmedDate) ? result.confirmedDate : null;
    return { id: result.id, status: result.status, value: result.value, billingType: result.billingType,
      checkoutSession: result.checkoutSession ?? null, subscription: result.subscription ?? null,
      confirmedDate };
  }

  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    if (!validResourceId(id)) throw new TypeError('Invalid subscription ID');
    const result = await this.#get(`/subscriptions/${encodeURIComponent(id)}`);
    if (result?.id !== id || !validId(result?.id) || !requiredString(result?.status) || !Number.isFinite(result?.value)
      || result.value < 0 || !requiredString(result?.cycle) || !validOptionalId(result?.checkoutSession)) throw new AsaasResponseError();
    return { id: result.id, status: result.status, value: result.value, cycle: result.cycle,
      checkoutSession: result.checkoutSession ?? null };
  }

  async #get(path: string): Promise<any> {
    const response = await this.#request(path, { method: 'GET' });
    if (!response.ok) throw new AsaasRequestRejectedError(response.status);
    try { return await readJsonBounded(response); } catch { throw new AsaasResponseError(); }
  }

  #request(path: string, options: { method: 'GET' | 'POST'; body?: string }): Promise<Response> {
    return this.#fetch(`${API_BASE}${path}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { access_token: this.#apiKey, 'content-type': 'application/json', 'user-agent': 'radar-asaas-sandbox-client/1.0' },
    }).catch(() => { throw new AsaasTransportError(); });
  }
}
