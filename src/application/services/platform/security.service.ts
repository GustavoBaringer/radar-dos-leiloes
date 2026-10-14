import { Injectable } from '@nestjs/common';
import type { RadarActorContext } from '../../../infra/http/radar-http-context.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';

@Injectable()
export class PlatformSecurityService {
  constructor(private readonly context: RadarHttpContext) {}
  clientConfig() { return this.context.challenge.clientConfig(); }
  metrics(actor?: RadarActorContext) {
    if (!Number.isSafeInteger(actor?.eu.userId) || (actor!.eu.userId as number) <= 0) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    if (actor!.papel !== 'admin') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    return { ...this.context.telemetry.snapshot(), images: this.context.imageTelemetry.snapshot() };
  }
}
