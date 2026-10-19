import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { RADAR_HTTP_CONTEXT } from '../../application/modules/http-platform/http-platform.module.js';
import { RadarHttpContext } from '../http/radar-http-context.js';

const VERSIONED_ASSETS = ['slug.js', 'cartao.js', 'landing.js', 'landing.css', 'cartao.css'];
const PUBLIC_ROUTES = [
  '/', '/robots.txt', '/sitemap.xml', '/api/vitrine', '/api/espera', '/api/cadastro', '/api/security-config',
  '/api/img', '/landing.css', '/landing.js', '/challenge.js', '/challenge.css', '/landing-antibot.js',
  '/landing-antibot.html', '/cartao.js', '/cartao.css', '/slug.js', '/nopic.svg', '/nopic-imovel.svg', '/mapa-lotes.jpg',
];

@Injectable()
export class PagesRepository {
  constructor(@Inject(RADAR_HTTP_CONTEXT) private readonly context: RadarHttpContext) {}

  versionedLanding(site: string): string {
    const dir = this.context.paths.webRoot;
    let html = readFileSync(join(dir, 'landing-antibot.html'), 'utf8').replaceAll('__SITE__', site);
    for (const asset of VERSIONED_ASSETS) {
      const version = Math.floor(statSync(join(dir, asset)).mtimeMs).toString(36);
      html = html.replaceAll(`"/${asset}"`, `"/${asset}?v=${version}"`);
    }
    return html;
  }
  hasSpa(): boolean { return existsSync(join(this.context.paths.appDist, 'client', 'index.html')); }
  spaShell(): string { return readFileSync(join(this.context.paths.appDist, 'client', 'index.html'), 'utf8'); }
  certificatePath(): string { return join(this.context.paths.certDir, 'ca.crt'); }
  hasCertificate(): boolean { return existsSync(this.certificatePath()); }
  certificate(): Buffer { return readFileSync(this.certificatePath()); }
  robots(site: string): string {
    return ['User-agent: *', 'Allow: /api/img', 'Disallow: /api/', 'Disallow: /login', 'Disallow: /busca',
      'Disallow: /alertas', 'Disallow: /cobertura', 'Disallow: /lote/', 'Allow: /', '', `Sitemap: ${site}/sitemap.xml`, ''].join('\n');
  }
  sitemap(site: string): string {
    const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
    const urls = PUBLIC_ROUTES.filter(route => !route.startsWith('/api/') && !/\.(css|js|svg|txt|xml)$/.test(route))
      .map(route => `<url><loc>${xml(site)}${route === '/' ? '/' : route}</loc><priority>${route === '/' ? '1.0' : '0.7'}</priority></url>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  }
}
