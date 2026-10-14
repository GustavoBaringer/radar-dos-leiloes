import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { parseSearchInput } from '../../../domain/search/request-bounds.js';
import { safePositiveId } from '../../../domain/search/request-bounds.js';
import { CatalogService, CatalogServiceError } from '../../services/catalog/catalog.service.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext, radarActorFromRequest, type RadarHttpRequest } from '../../../infra/http/radar-http-context.js';
import { CatalogSearchQueryDto } from './catalog.dto.js';

@ApiTags('catalog')
@Controller('api')
export class CatalogController {
  constructor(private readonly catalog: CatalogService, @Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext) {}
  private actor(req: RadarHttpRequest) { return radarActorFromRequest(req)?.eu; }
  private read<T>(work: () => T | Promise<T>) { return this.context.runRead(work); }

  @Get('home') home(@Req() req: RadarHttpRequest) {
    return this.read(() => this.catalog.home(this.actor(req)!));
  }
  @Get('vitrine') vitrine() { return this.read(() => this.catalog.vitrine()); }
  @Get('home/leiloeiro')
  @ApiQuery({ name: 'nome', required: false, type: String })
  homeLeiloeiro(@Req() req: RadarHttpRequest, @Query() query: Record<string, unknown>, @Res({ passthrough: true }) reply: FastifyReply) {
    if (Array.isArray(query.nome) || (query.nome !== undefined && typeof query.nome !== 'string')) {
      reply.code(400);
      return { error: 'nome inválido' };
    }
    return this.read(() => this.catalog.homeLeiloeiro(String(query.nome ?? ''), this.actor(req)!));
  }
  @Get('search') search(@Req() req: RadarHttpRequest, @Query() query: CatalogSearchQueryDto) {
    const input = parseSearchInput({ ...query });
    return this.read(() => this.catalog.search(input, this.actor(req)!));
  }
  @Get('search/mapa') searchMap(@Req() req: RadarHttpRequest, @Query() query: CatalogSearchQueryDto) {
    const input = parseSearchInput({ ...query });
    return this.read(() => this.catalog.searchMap(input, this.actor(req)!));
  }
  @Get('lot/:id') detail(@Req() req: RadarHttpRequest, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.read<unknown>(() => {
      const parsed = safePositiveId(id);
      if (parsed === null) { reply.code(400); return { error: 'id inválido' }; }
      return this.catalog.detail(parsed, this.actor(req)!);
    });
  }
  @Get('malha/:tipo') malha(@Req() req: RadarHttpRequest, @Param('tipo') tipo: string, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.read<unknown>(() => {
      try {
        const data = this.catalog.malha(tipo, this.context.paths.dataDir, this.actor(req)!);
        reply.type('application/json').header('cache-control', 'public, max-age=604800, immutable');
        return data;
      } catch (error) {
        if (error instanceof CatalogServiceError && error.statusCode === 404) {
          reply.code(404);
          return { error: error.message };
        }
        throw error;
      }
    });
  }
  @Get('stats') stats(@Req() req: RadarHttpRequest) { return this.read(() => this.catalog.stats(this.actor(req)!)); }
  @Get('sources') sources(@Req() req: RadarHttpRequest) { return this.read(() => this.catalog.sources(this.actor(req)!)); }
  @Get('brands') brands(@Req() req: RadarHttpRequest) { return this.read(() => this.catalog.brands(this.actor(req)!)); }
  @Get('explain')
  @ApiQuery({ name: 'q', required: false, type: String })
  explain(@Req() req: RadarHttpRequest, @Query() query: CatalogSearchQueryDto) {
    const input = parseSearchInput({ ...query });
    return this.read(() => this.catalog.explain(input.q, this.actor(req)!));
  }
}
