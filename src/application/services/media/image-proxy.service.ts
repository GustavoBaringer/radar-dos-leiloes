import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from 'undici';
import { createImageService, type ImageOutcome, type ImageRequester } from '../../../core/antibot/images.js';
import { tryAcquireImageJob } from '../../security/resource-limits.js';
import { createImageMetricsLog } from '../../../core/antibot/image-metrics-log.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { imageHostAllowed, loadImageHosts } from '../../../infra/media/image-hosts.repository.js';

export const IMAGE_REQUESTER = Symbol('IMAGE_REQUESTER');

export interface ImageProxyInput { url?: string; width?: number | null }
export interface ImageProxyResult { outcome: ImageOutcome; placeholder?: string }
interface PlatformAdmission { readAdmission?: () => { release(): void } | null }

@Injectable()
export class ImageProxyService implements OnModuleInit, OnModuleDestroy {
  private image?: ReturnType<typeof createImageService>;
  private placeholder = '';
  private tlsAgent?: Agent;
  private timer?: NodeJS.Timeout;
  private persistedMinute = '';
  private readonly metricsLog;

  constructor(
    @Inject(RadarHttpContext) private readonly context: RadarHttpContext,
    @Inject(IMAGE_REQUESTER) private readonly requester?: ImageRequester,
  ) {
    this.metricsLog = createImageMetricsLog(context.env.IMAGE_METRICS_DIR);
  }

  async onModuleInit(): Promise<void> {
    const hosts = await loadImageHosts(this.context);
    this.tlsAgent = new Agent({ connect: { rejectUnauthorized: false } });
    this.image = createImageService({
      safeHostChecker: (url) => url.protocol === 'https:' && imageHostAllowed(hosts, url.host),
      refererForHost: (host) => host === 's3-sa-east-1.amazonaws.com' ? 'https://www.valland.com.br/' : `https://${host}/`,
      dispatcherForHost: (host) => this.context.runtime.hostsTlsIncomplete.has(host) ? this.tlsAgent : undefined,
      request: this.requester,
      tryAcquireImageJob,
      // PlatformContext owns this callback; consume the existing admission lease for misses.
      acquireDegradedWork: () => {
        const platform = this.context as unknown as PlatformAdmission;
        return platform.readAdmission ? platform.readAdmission() : { release() {} };
      },
    });
    try { this.placeholder = await readFile(join(this.context.paths.webRoot, 'nopic.svg'), 'utf8'); }
    catch { this.placeholder = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#ddd"/></svg>'; }
    this.timer = setInterval(() => this.persistMinute(), 10_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.persistMinute();
    this.context.imageTelemetry.flush(true);
    await this.image?.close();
    await this.metricsLog.close();
    await this.tlsAgent?.close();
  }

  async get(input: ImageProxyInput, signal: AbortSignal, onCache: (cache: 'hit' | 'miss') => void): Promise<ImageProxyResult> {
    if (!this.image) throw new Error('Image proxy not initialized');
    const outcome = await this.image.get(input.url, input.width, { signal, onCache });
    return outcome.kind === 'placeholder' ? { outcome, placeholder: this.placeholder } : { outcome };
  }
  startTelemetry(client: string): number { return this.context.imageTelemetry.start(client); }
  completeTelemetry(started: number, status: number, cache: unknown, placeholder: boolean): void {
    this.context.imageTelemetry.complete(started, status, cache, placeholder);
  }
  private persistMinute(): void {
    const minute = this.context.imageTelemetry.snapshot().currentMinute;
    if (minute.minuteUtc !== this.persistedMinute && (minute.requests || minute.completed)) {
      this.persistedMinute = minute.minuteUtc;
      this.metricsLog.write(minute);
    }
  }
}
