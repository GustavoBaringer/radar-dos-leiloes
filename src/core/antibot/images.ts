import { request as undiciRequest, type Dispatcher } from 'undici';
import sharp from 'sharp';
import type { ResourceLease } from './resources.js';

const MIB = 1024 * 1024;
const WIDTH_BUCKETS = [120, 240, 360, 480, 640, 800, 1000, 1200, 1600] as const;

export type ImagePlaceholderReason =
  | 'missing-url' | 'invalid-url' | 'unsafe-url' | 'host-not-allowed'
  | 'redirect-invalid' | 'redirect-loop' | 'redirect-limit' | 'upstream-status'
  | 'too-large' | 'invalid-raster' | 'invalid-dimensions' | 'decode-failed'
  | 'deadline' | 'upstream-failed' | 'service-closed';

export type ImageOutcome =
  | { kind: 'image'; buffer: Buffer; contentType: string; cache: 'hit' | 'miss' }
  | { kind: 'placeholder'; reason: ImagePlaceholderReason }
  | { kind: 'source-failure'; reason: 'client-aborted' | 'service-closed' }
  | { kind: 'quota'; retryAfterSeconds: number }
  | { kind: 'overload' };

export type MissQuotaDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface ImageResponseBody extends AsyncIterable<Uint8Array> {
  destroy?: () => void;
}

export interface ImageTransportResponse {
  statusCode: number;
  headers: {
    location?: string | string[];
    'content-length'?: string | string[];
    'content-type'?: string | string[];
  };
  body: ImageResponseBody;
}

export interface ImageRequestOptions {
  headers: Record<string, string>;
  signal: AbortSignal;
  dispatcher?: Dispatcher;
  headersTimeout: number;
  bodyTimeout: number;
}

export type ImageRequester = (url: string, options: ImageRequestOptions) => Promise<ImageTransportResponse>;
export type ImageProcessor = (
  input: Buffer,
  contentType: string,
  width: number | null,
  maxPixels: number,
) => Promise<{ buffer: Buffer; contentType: string }>;

export interface ImageLimits {
  readonly maxUrlLength: number;
  readonly maxRedirects: number;
  readonly deadlineMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxPixels: number;
  readonly maxCacheEntries: number;
  readonly maxCacheBytes: number;
  readonly cacheTtlMs: number;
}

const DEFAULT_LIMITS: ImageLimits = {
  maxUrlLength: 4_096,
  maxRedirects: 3,
  deadlineMs: 15_000,
  maxInputBytes: 20 * MIB,
  maxOutputBytes: 20 * MIB,
  maxPixels: 40_000_000,
  maxCacheEntries: 300,
  maxCacheBytes: 64 * MIB,
  cacheTtlMs: 30 * 60_000,
};

const LIMIT_MAX: ImageLimits = {
  maxUrlLength: 4_096,
  maxRedirects: 3,
  deadlineMs: 15_000,
  maxInputBytes: 20 * MIB,
  maxOutputBytes: 20 * MIB,
  maxPixels: 40_000_000,
  maxCacheEntries: 300,
  maxCacheBytes: 64 * MIB,
  cacheTtlMs: 30 * 60_000,
};

class ImageDimensionsError extends Error {}

export interface ImageServiceOptions {
  /** Adapter to the server's existing derived allowlist; called for every hop. */
  safeHostChecker: (url: URL) => boolean | Promise<boolean>;
  refererForHost?: (host: string) => string | undefined;
  dispatcherForHost?: (host: string) => Dispatcher | undefined;
  request?: ImageRequester;
  processImage?: ImageProcessor;
  /** Default miss quota check; request handlers may instead pass a request-scoped check to get(). */
  checkMiss?: () => Promise<MissQuotaDecision>;
  tryAcquireResource: () => ResourceLease | null;
  tryAcquireImageJob: () => ResourceLease | null;
  acquireDegradedWork: () => ResourceLease | null;
  clock?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  limits?: Partial<ImageLimits>;
}

export interface ImageService {
  get(url: string | null | undefined, width?: number | null, context?: ImageRequestContext): Promise<ImageOutcome>;
  close(): Promise<void>;
}

export interface ImageRequestContext {
  signal?: AbortSignal;
  /** Must check imageMiss for the requesting IP; invoked only for a cache miss. */
  checkMiss?: () => Promise<MissQuotaDecision>;
}

interface CacheEntry {
  readonly buffer: Buffer;
  readonly contentType: string;
  readonly insertedAt: number;
}

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

function destroyBody(body: ImageResponseBody | undefined): void {
  try { body?.destroy?.(); } catch { /* best effort stream cancellation */ }
}

function widthBucket(width: number | null | undefined): number | null {
  if (width == null || !Number.isFinite(width) || width <= 0) return null;
  return WIDTH_BUCKETS.find((bucket) => bucket >= width) ?? WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1];
}

function rasterType(input: Buffer): string | null {
  if (input.length < 12) return null;
  if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'image/jpeg';
  if (input.subarray(0, 4).toString('latin1') === '\x89PNG') return 'image/png';
  if (input.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (input.subarray(0, 4).toString('latin1') === 'RIFF' && input.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (input.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = input.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif') || brand.startsWith('avis') || brand === 'mif1') return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand === 'hevc' || brand === 'hevx') return 'image/heic';
  }
  return null;
}

async function processWithSharp(input: Buffer, contentType: string, width: number | null, maxPixels: number) {
  const options = { limitInputPixels: maxPixels, failOn: 'warning' as const, sequentialRead: true };
  const metadata = await sharp(input, options).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxPixels) {
    throw new ImageDimensionsError('invalid image dimensions');
  }
  if (width === null) {
    // stats forces a complete native decode while returning original bytes when no resize was requested.
    await sharp(input, options).stats();
    return { buffer: input, contentType };
  }
  const buffer = await sharp(input, options)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  return { buffer, contentType: 'image/webp' };
}

function configuredLimits(overrides: Partial<ImageLimits> = {}): ImageLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ImageLimits)[]) {
    const value = limits[key];
  const minimum = key === 'maxRedirects' ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > LIMIT_MAX[key]) {
      throw new Error(`${key} deve ser inteiro entre ${minimum} e ${LIMIT_MAX[key]}`);
    }
  }
  if (limits.maxUrlLength < 16 || limits.maxRedirects > 3) throw new Error('image limits inválidos');
  return limits;
}

function allowedHttpsUrl(raw: string, maxLength: number): URL | null {
  if (!raw || raw.length > maxLength) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  url.hash = '';
  return url;
}

function makeRequester(): ImageRequester {
  return async (url, options) => undiciRequest(url, options) as unknown as Promise<ImageTransportResponse>;
}

export function createImageService(options: ImageServiceOptions): ImageService {
  const limits = configuredLimits(options.limits);
  const now = options.clock ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const request = options.request ?? makeRequester();
  const processImage = options.processImage ?? processWithSharp;
  const cache = new Map<string, CacheEntry>();
  const activeControllers = new Map<AbortController, () => void>();
  const operations = new Set<Promise<ImageOutcome>>();
  let cacheBytes = 0;
  let closed = false;

  const deleteCacheEntry = (key: string) => {
    const previous = cache.get(key);
    if (!previous) return;
    cache.delete(key);
    cacheBytes -= previous.buffer.byteLength;
  };
  const pruneExpired = (time: number) => {
    for (const [key, entry] of cache) {
      if (time - entry.insertedAt >= limits.cacheTtlMs) deleteCacheEntry(key);
    }
  };
  const cacheGet = (key: string, time: number): CacheEntry | null => {
    pruneExpired(time);
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  };
  const cachePut = (key: string, entry: CacheEntry, time: number) => {
    pruneExpired(time);
    deleteCacheEntry(key);
    if (entry.buffer.byteLength > limits.maxCacheBytes) return;
    while (cache.size >= limits.maxCacheEntries || cacheBytes + entry.buffer.byteLength > limits.maxCacheBytes) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      deleteCacheEntry(oldest);
    }
    cache.set(key, entry);
    cacheBytes += entry.buffer.byteLength;
  };

  async function fetchRaster(url: URL, width: number | null, signal: AbortSignal, deadlineAt: number): Promise<ImageOutcome> {
    let target = url;
    const visited = new Set<string>([target.href]);
    let currentBody: ImageResponseBody | undefined;
    const destroyOnAbort = () => destroyBody(currentBody);
    signal.addEventListener('abort', destroyOnAbort);
    try {
    for (let redirects = 0; ; redirects++) {
      if (signal.aborted) return { kind: 'placeholder', reason: 'deadline' };
      if (now() >= deadlineAt) return { kind: 'placeholder', reason: 'deadline' };
      try {
        if (!await options.safeHostChecker(target)) return { kind: 'placeholder', reason: 'host-not-allowed' };
      } catch {
        return { kind: 'placeholder', reason: 'host-not-allowed' };
      }
      const referer = options.refererForHost?.(target.host) ?? `${target.origin}/`;
      const remaining = Math.max(1, Math.ceil(deadlineAt - now()));
      let response: ImageTransportResponse;
      try {
        response = await request(target.href, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
            referer,
          },
          signal,
          dispatcher: options.dispatcherForHost?.(target.host),
          headersTimeout: remaining,
          bodyTimeout: remaining,
        });
      } catch {
        return signal.aborted ? { kind: 'placeholder', reason: 'deadline' } : { kind: 'placeholder', reason: 'upstream-failed' };
      }
      currentBody = response.body;

      const location = header(response.headers.location);
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        destroyBody(response.body);
        currentBody = undefined;
        if (redirects >= limits.maxRedirects) return { kind: 'placeholder', reason: 'redirect-limit' };
        let next: URL | null;
        try { next = allowedHttpsUrl(new URL(location, target).href, limits.maxUrlLength); }
        catch { return { kind: 'placeholder', reason: 'redirect-invalid' }; }
        if (!next) return { kind: 'placeholder', reason: 'redirect-invalid' };
        target = next;
        if (visited.has(target.href)) return { kind: 'placeholder', reason: 'redirect-loop' };
        visited.add(target.href);
        continue;
      }
      if (response.statusCode !== 200) {
        destroyBody(response.body);
        currentBody = undefined;
        return { kind: 'placeholder', reason: 'upstream-status' };
      }
      const contentLength = header(response.headers['content-length']);
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limits.maxInputBytes) {
        destroyBody(response.body);
        currentBody = undefined;
        return { kind: 'placeholder', reason: 'too-large' };
      }

      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of response.body) {
          if (signal.aborted) {
            destroyBody(response.body);
            currentBody = undefined;
            return { kind: 'placeholder', reason: 'deadline' };
          }
          if (total + chunk.byteLength > limits.maxInputBytes) {
            destroyBody(response.body);
            currentBody = undefined;
            return { kind: 'placeholder', reason: 'too-large' };
          }
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(bytes);
          total += bytes.byteLength;
        }
      } catch {
        destroyBody(response.body);
        currentBody = undefined;
        return signal.aborted ? { kind: 'placeholder', reason: 'deadline' } : { kind: 'placeholder', reason: 'upstream-failed' };
      }
      currentBody = undefined;
      if (total === 0) return { kind: 'placeholder', reason: 'invalid-raster' };
      const input = Buffer.concat(chunks, total);
      const contentType = rasterType(input);
      if (!contentType) return { kind: 'placeholder', reason: 'invalid-raster' };

      if (signal.aborted) return { kind: 'placeholder', reason: 'deadline' };
      try {
        const result = await processImage(input, contentType, width, limits.maxPixels);
        if (signal.aborted) return { kind: 'placeholder', reason: 'deadline' };
        if (result.buffer.byteLength > limits.maxOutputBytes) return { kind: 'placeholder', reason: 'too-large' };
        return { kind: 'image', buffer: result.buffer, contentType: result.contentType, cache: 'miss' };
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        return {
          kind: 'placeholder',
          reason: error instanceof ImageDimensionsError || /pixel limit|dimensions/.test(message) ? 'invalid-dimensions' : 'decode-failed',
        };
      }
    }
    } finally {
      signal.removeEventListener('abort', destroyOnAbort);
      if (signal.aborted) destroyBody(currentBody);
    }
  }

  async function runMiss(key: string, url: URL, width: number | null, context: ImageRequestContext): Promise<ImageOutcome> {
    const clientSignal = context.signal;
    let resourceLease: ResourceLease | null = null;
    let imageLease: ResourceLease | null = null;
    let degradedLease: ResourceLease | null = null;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortCause: 'client' | 'deadline' | 'closed' | null = null;
    const onClientAbort = () => {
      if (abortCause) return;
      abortCause = 'client';
      controller?.abort();
    };
    try {
      let quota: MissQuotaDecision;
      const checkMiss = context.checkMiss ?? options.checkMiss;
      if (!checkMiss) return { kind: 'overload' };
      try { quota = await checkMiss(); }
      catch { return { kind: 'overload' }; }
      if (closed) return { kind: 'source-failure', reason: 'service-closed' };
      if (!quota.allowed) return { kind: 'quota', retryAfterSeconds: Math.max(1, quota.retryAfterSeconds) };
      if (clientSignal?.aborted) return { kind: 'source-failure', reason: 'client-aborted' };

      try {
        resourceLease = options.tryAcquireResource();
        if (!resourceLease) return { kind: 'overload' };
        imageLease = options.tryAcquireImageJob();
        if (!imageLease) return { kind: 'overload' };
        degradedLease = options.acquireDegradedWork();
        if (!degradedLease) return { kind: 'overload' };
      } catch {
        return { kind: 'overload' };
      }

      controller = new AbortController();
      const deadlineAt = now() + limits.deadlineMs;
      const onDeadline = () => {
        if (abortCause) return;
        abortCause = 'deadline';
        controller?.abort();
      };
      timer = setTimer(onDeadline, limits.deadlineMs);
      clientSignal?.addEventListener('abort', onClientAbort, { once: true });
      if (clientSignal?.aborted) onClientAbort();
      activeControllers.set(controller, () => {
        if (!abortCause) abortCause = 'closed';
        controller?.abort();
      });

      const result = await fetchRaster(url, width, controller.signal, deadlineAt);
      if (abortCause === 'client') return { kind: 'source-failure', reason: 'client-aborted' };
      if (abortCause === 'closed') return { kind: 'source-failure', reason: 'service-closed' };
      if (abortCause === 'deadline') return { kind: 'placeholder', reason: 'deadline' };
      if (result.kind === 'image') {
        cachePut(key, { buffer: result.buffer, contentType: result.contentType, insertedAt: now() }, now());
      }
      return result;
    } catch {
      return abortCause === 'client'
        ? { kind: 'source-failure', reason: 'client-aborted' }
        : { kind: 'placeholder', reason: abortCause === 'deadline' ? 'deadline' : 'upstream-failed' };
    } finally {
      if (timer !== undefined) clearTimer(timer);
      clientSignal?.removeEventListener('abort', onClientAbort);
      if (controller) activeControllers.delete(controller);
      degradedLease?.release();
      imageLease?.release();
      resourceLease?.release();
    }
  }

  async function get(urlInput: string | null | undefined, widthInput: number | null = null, context: ImageRequestContext = {}): Promise<ImageOutcome> {
    if (closed) return { kind: 'placeholder', reason: 'service-closed' };
    if (!urlInput) return { kind: 'placeholder', reason: 'missing-url' };
    const url = allowedHttpsUrl(urlInput, limits.maxUrlLength);
    if (!url) return { kind: 'placeholder', reason: 'invalid-url' };
    try {
      if (!await options.safeHostChecker(url)) return { kind: 'placeholder', reason: 'host-not-allowed' };
    } catch {
      return { kind: 'placeholder', reason: 'host-not-allowed' };
    }
    const width = widthBucket(widthInput);
    const key = `${url.href}|${width ?? 'full'}`;
    const cached = cacheGet(key, now());
    if (cached) return { kind: 'image', buffer: cached.buffer, contentType: cached.contentType, cache: 'hit' };

    const operation = runMiss(key, url, width, context);
    operations.add(operation);
    try { return await operation; }
    finally { operations.delete(operation); }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const abort of activeControllers.values()) {
      // Module shutdown is not a client abort; abort fetches, but await Sharp before releasing slots.
      abort();
    }
    await Promise.allSettled([...operations]);
    cache.clear();
    cacheBytes = 0;
  }

  return { get, close };
}
