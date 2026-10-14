import { ArgumentsHost, Body, Catch, Controller, Delete, ExceptionFilter, Get, Headers, Inject, Param, Patch, Post, Query, Req, Res, UseFilters } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AccountsService, AccountsServiceError } from '../../services/accounts/accounts.service.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext, radarActorFromRequest, type RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { AccountBodyDto, AccountPaginationDto } from './accounts.dto.js';

@ApiTags('accounts')
@Controller('api')
export class AccountsController {
  constructor(private readonly accounts: AccountsService, @Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext) {}

  private async invoke<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
  private actor(req: RadarHttpRequest) { return radarActorFromRequest(req)?.eu; }
  private read<T>(work: () => Promise<T>) { return this.context.runRead(work); }

  @Get('me') me(@Req() req: RadarHttpRequest) {
    return this.read(() => this.invoke(() => this.accounts.me(this.actor(req)!, { oidc: this.context.oidc.oidcLigado(), saiuEmDev: /(?:^|;)\s*radar_saiu=1/.test(String(req.headers.cookie ?? '')) })));
  }
  @Get('alerts') alerts(@Req() req: RadarHttpRequest, @Query() query: AccountPaginationDto) {
    return this.read(() => this.invoke(() => this.accounts.listAlerts(this.actor(req)!, query)));
  }
  @Post('alerts') createAlert(@Req() req: RadarHttpRequest, @Body() body: AccountBodyDto) {
    return this.read(() => this.invoke(() => this.accounts.createAlert(this.actor(req)!, { ...body })));
  }
  @Patch('alerts/:id') updateAlert(@Req() req: RadarHttpRequest, @Param('id') id: string, @Body() body: AccountBodyDto) {
    return this.read(() => this.invoke(() => this.accounts.updateAlert(this.actor(req)!, id, { ...body })));
  }
  @Delete('alerts/:id') deleteAlert(@Req() req: RadarHttpRequest, @Param('id') id: string) {
    return this.read(() => this.invoke(() => this.accounts.deleteAlert(this.actor(req)!, id)));
  }
  @Get('alerts/hits') alertHits(@Req() req: RadarHttpRequest, @Query() query: Record<string, unknown>) {
    return this.read(() => this.invoke(() => this.accounts.listAlertHits(this.actor(req)!, query)));
  }
  @Post('alerts/hits/seen') seen(@Req() req: RadarHttpRequest, @Body() body: AccountBodyDto) {
    return this.read(() => this.invoke(() => this.accounts.markAlertHitsSeen(this.actor(req)!, { ...body })));
  }
  @Get('favorites') favorites(@Req() req: RadarHttpRequest, @Query() query: AccountPaginationDto) {
    return this.read(() => this.invoke(() => this.accounts.listFavorites(this.actor(req)!, query)));
  }
  @Post('favorites') addFavorite(@Req() req: RadarHttpRequest, @Body() body: AccountBodyDto) {
    return this.read(() => this.invoke(() => this.accounts.addFavorite(this.actor(req)!, { ...body })));
  }
  @Delete('favorites/:lotId') deleteFavorite(@Req() req: RadarHttpRequest, @Param('lotId') id: string) {
    return this.read(() => this.invoke(() => this.accounts.deleteFavorite(this.actor(req)!, id)));
  }
  @Get('push/key') pushKey() { return this.accounts.pushKey(); }
  @Post('push/subscribe') subscribe(@Req() req: RadarHttpRequest, @Body() body: AccountBodyDto, @Headers('user-agent') agent?: string) {
    return this.read(() => this.invoke(() => this.accounts.subscribePush(this.actor(req)!, { ...body }, agent)));
  }
  @Get('notificacoes/status') status(@Req() req: RadarHttpRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return this.read(() => this.invoke(() => this.accounts.notificationStatus(this.actor(req)!)));
  }
  @Post('espera') waitlist(@Body() body: AccountBodyDto) {
    return this.read(() => this.invoke(() => this.accounts.joinWaitlist({ ...body })));
  }
  @Post('cadastro') async register(@Req() req: RadarHttpRequest, @Body() body: AccountBodyDto, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.code(201);
    return this.read(() => this.invoke(() => this.accounts.register({ ...body }, req.clientIp ?? '')));
  }
}

@Catch(AccountsServiceError)
class AccountsServiceExceptionFilter implements ExceptionFilter {
  catch(error: AccountsServiceError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    reply.code(error.statusCode).send({ erro: error.message, ...(error.field ? { campo: error.field } : {}) });
  }
}

UseFilters(AccountsServiceExceptionFilter)(AccountsController);
