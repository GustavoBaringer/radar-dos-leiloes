import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { idDoSlug, slugDoLote } from '../../../domain/lots/slug.js';
import { toPublicLot } from '../../../domain/lots/public-dto.js';
import type { Identidade } from '../../../domain/identity/identidade.js';
import { RADAR_HTTP_CONTEXT } from '../../modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../../../infra/http/radar-http-context.js';
import { formatMoney, loadLotRenderer, escapeHtml } from '../../../infra/web/page-renderer.js';
import { PagesRepository } from '../../../infra/web/pages.repository.js';
import { AccountContextService } from '../accounts/account-context.service.js';

export interface PagePlan { status?: number; contentType?: string; headers?: Record<string, string>; location?: string; body?: unknown }
export interface PageRequest { protocol: string; host?: string; forwardedHost?: string; forwardedProto?: string; userAgent?: string }

const CRAWLER = /facebookexternalhit|Twitterbot|LinkedInBot|WhatsApp|Slack-ImgProxy|TelegramBot|Googlebot|bingbot|Applebot/i;

@Injectable()
export class PagesService {
  constructor(
    @Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext,
    private readonly pages: PagesRepository,
    @Inject(AccountContextService) private readonly accountContext: AccountContextService,
  ) {}

  landing(): PagePlan {
    const site = (this.context.env.SITE_URL ?? 'http://localhost:4500').replace(/\/$/, '');
    return { contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'no-cache' }, body: this.pages.versionedLanding(site) };
  }
  spa(): PagePlan {
    if (!this.pages.hasSpa()) return { status: 503, contentType: 'text/plain; charset=utf-8', body: 'app-busca não construído: rode `npm run build` em app-busca/' };
    return { contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'no-cache' }, body: this.pages.spaShell() };
  }
  robots(): PagePlan {
    const site = (this.context.env.SITE_URL ?? 'http://localhost:4500').replace(/\/$/, '');
    return { contentType: 'text/plain; charset=utf-8', body: this.pages.robots(site) };
  }
  sitemap(): PagePlan {
    const site = (this.context.env.SITE_URL ?? 'http://localhost:4500').replace(/\/$/, '');
    return { contentType: 'application/xml; charset=utf-8', body: this.pages.sitemap(site) };
  }
  certificate(): PagePlan {
    if (!this.pages.hasCertificate()) return { status: 404, body: { erro: 'CA não gerada' } };
    return { contentType: 'application/x-x509-ca-cert', headers: { 'content-disposition': 'attachment; filename="radar-leiloes-ca.crt"' }, body: this.pages.certificate() };
  }

  async lot(slug: string, actor: Identidade | undefined, req: PageRequest): Promise<PagePlan> {
    if (!this.pages.hasSpa()) return { status: 503, contentType: 'text/plain; charset=utf-8', body: 'app-busca não construído' };
    const id = idDoSlug(slug);
    const lot = id !== null ? await this.context.data.getLot(id, { interno: actor?.papel === 'admin' }) : null;
    if (!lot) return { status: 302, location: '/busca', headers: { 'cache-control': 'no-store' } };
    if (slug !== slugDoLote(lot)) return { status: 404, headers: { 'cache-control': 'no-store' }, body: { erro: 'Lote não encontrado.' } };

    const publicLot = toPublicLot(lot);
    const isCrawler = Boolean(actor?.userId === 0 && CRAWLER.test(req.userAgent ?? ''));
    let lotForRender: ReturnType<typeof toPublicLot> & { favorited?: boolean };
    if (actor && actor.userId > 0) {
      lotForRender = (await this.accountContext.decorateLots(actor.userId, [publicLot]))[0]!;
    } else if (isCrawler) {
      // Public crawler SSR never queries account-owned favorites or exposes internal columns.
      lotForRender = { ...publicLot, favorited: false };
    } else {
      throw Object.assign(new Error('não autenticado'), { statusCode: 401 });
    }

    const html = this.pages.spaShell();
    const title = lotForRender.title_display || lotForRender.title_raw;
    const local = [lotForRender.city, lotForRender.state].filter(Boolean).join('/');
    const bid = formatMoney(lotForRender.current_bid ?? lotForRender.min_bid);
    const kind = lotForRender.asset_type === 'imovel' ? 'Imóvel' : 'Veículo';
    const description = [
      `${kind} em leilão: ${title}.`, local ? `Local: ${local}.` : '',
      bid ? `Lance ${lot.current_bid != null ? 'atual' : 'mínimo'}: ${bid}.` : 'Sem lance publicado.',
      'Prazo e link direto para o site do leiloeiro no Radar de Leilões.',
    ].filter(Boolean).join(' ');
    const origin = this.origin(req);
    const photo = lotForRender.photos?.[0] ? `${origin}/api/img?u=${encodeURIComponent(lotForRender.photos[0])}&w=1200` : '';
    const jsonld = {
      '@context': 'https://schema.org', '@type': 'Product', name: title, description,
      ...(photo ? { image: photo } : {}), ...(lotForRender.brand ? { brand: { '@type': 'Brand', name: lotForRender.brand } } : {}),
      offers: {
        '@type': 'Offer', priceCurrency: 'BRL',
        ...(lotForRender.current_bid ?? lotForRender.min_bid ? { price: String(lotForRender.current_bid ?? lotForRender.min_bid) } : {}),
        availability: 'https://schema.org/InStock', url: `${origin}/lote/${slug}`,
        ...(lotForRender.auction_end_utc ? { priceValidUntil: new Date(lotForRender.auction_end_utc).toISOString().slice(0, 10) } : {}),
        ...(lotForRender.auctioneer_name ? { seller: { '@type': 'Organization', name: lotForRender.auctioneer_name } } : {}),
      },
    };
    const head = [
      `<title>${escapeHtml(title)}${local ? ` em ${escapeHtml(local)}` : ''} — leilão | Radar de Leilões</title>`,
      `<meta name="description" content="${escapeHtml(description)}">`, `<link rel="canonical" href="${origin}/lote/${escapeHtml(slug)}">`,
      '<meta property="og:type" content="product">', `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(description)}">`, photo ? `<meta property="og:image" content="${escapeHtml(photo)}">` : '',
      '<meta name="twitter:card" content="summary_large_image">', `<script type="application/ld+json">${JSON.stringify(jsonld).replaceAll('<', '\\u003c')}</script>`,
    ].filter(Boolean).join('\n');
    let body = html.replace(/<meta\s+name="description"[^>]*>/gi, '').replace(/<meta\s+property="og:(title|description|type|image|url)"[^>]*>/gi, '').replace(/<title>[\s\S]*?<\/title>/, head);

    const render = await loadLotRenderer(this.context.paths.appDist);
    if (render) {
      try {
        const marked = render(lotForRender, isCrawler);
        const preloads: string[] = [];
        const rendered = marked.replace(/<link\b[^>]*\brel="(?:preload|preconnect|dns-prefetch|stylesheet)"[^>]*>/g, match => { preloads.push(match); return ''; });
        const safeState = JSON.stringify(lotForRender).replaceAll('<', '\\u003c');
        body = body.replace('<div id="root"></div>', `<div id="root">${rendered}</div>`)
          .replace('</head>', `${preloads.join('')}<script>window.__LOTE__=${safeState};window.__PUBLICO__=${isCrawler}</script></head>`);
      } catch { /* Existing contract falls back to the client shell on SSR failure. */ }
    }
    return { contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'private, no-store' }, body };
  }

  private origin(req: PageRequest): string {
    if (this.context.env.SITE_URL) return this.context.env.SITE_URL.replace(/\/$/, '');
    const host = String(req.forwardedHost ?? req.host ?? '').split(',')[0]!.trim();
    if (!host || !/^[a-z0-9.\-:]+$/i.test(host)) return 'http://localhost:4500';
    const proto = String(req.forwardedProto ?? req.protocol ?? 'http').split(',')[0]!.trim();
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  }
}
