import { Inject, Injectable } from '@nestjs/common';
import { RadarHttpContext, type RadarActorContext } from '../../../infra/http/radar-http-context.js';

@Injectable()
export class CollectionAdminService {
  constructor(@Inject(RadarHttpContext) private readonly context: RadarHttpContext) {}
  async enqueue(actor: RadarActorContext | undefined, input: unknown) {
    if (!Number.isSafeInteger(actor?.eu.userId) || (actor!.eu.userId as number) <= 0) throw Object.assign(new Error('Autenticação necessária.'), { statusCode: 401 });
    this.context.requireAdmin(actor!.papel);
    if (input == null) input = {};
    if (typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('body inválido'), { statusCode: 400 });
    const body = input as { sourceId?: unknown; limit?: unknown };
    const known = this.context.jobs.connectors.map((connector) => connector.def.id);
    if (body.sourceId != null && (typeof body.sourceId !== 'string' || !known.includes(body.sourceId))) {
      throw Object.assign(new Error(`fonte desconhecida: ${String(body.sourceId)}`), { statusCode: 400, fontesValidas: known });
    }
    if (body.limit != null && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 10_000)) throw Object.assign(new Error('limit inválido'), { statusCode: 400 });
    const targets = body.sourceId ? [body.sourceId] : known;
    const limit = typeof body.limit === 'number' ? body.limit : 300;
    const queue = await this.context.collectQueue();
    const enfileirado = [];
    for (const sourceId of targets) {
      const job = await queue.add('collect:manual', { sourceId, limit });
      enfileirado.push({ sourceId, jobId: job.id });
    }
    return { enfileirado };
  }
}
