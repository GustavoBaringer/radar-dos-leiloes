import { Controller, HttpCode, HttpException, Inject, NotFoundException, Post, Req, UnsupportedMediaTypeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AsaasWebhookPayloadError } from '../../../domain/billing/asaas-webhook.js';
import { ASAAS_WEBHOOK_SERVICE, AsaasWebhookService } from '../../services/billing/asaas-webhook.service.js';

@Controller('api/webhooks/asaas')
export class AsaasWebhookController {
  constructor(@Inject(ASAAS_WEBHOOK_SERVICE) private readonly service: AsaasWebhookService | null) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() request: FastifyRequest): Promise<{ received: true }> {
    if (!this.service) throw new NotFoundException('Not found');
    if (String(request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
      throw new UnsupportedMediaTypeException('Unsupported media type');
    }
    try {
      await this.service.receive(request.headers['asaas-access-token'], request.body);
      return { received: true };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 401) throw new HttpException('Unauthorized', 401);
      if (error instanceof AsaasWebhookPayloadError) throw new HttpException('Invalid webhook payload', 400);
      throw new HttpException('Webhook temporarily unavailable', 503);
    }
  }
}
