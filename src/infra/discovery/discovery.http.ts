import { Injectable } from '@nestjs/common';
import { fetchJson } from '../../connectors/http.js';
import { request, Agent, interceptors } from 'undici';

export interface DiscoveryHttpPort {
  fenajuPage(page: number): Promise<any>;
  probe(url: string, timeout?: number): Promise<{ status: number; body: string }>;
}

const BASE_FENAJU = 'https://www.fenaju.org.br/api/public/leiloeiros';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Redirect via interceptor: nesta versão do undici `request` não aceita maxRedirections.
const agente = new Agent({ connect: { rejectUnauthorized: false } }).compose(
  interceptors.redirect({ maxRedirections: 4 }),
);

@Injectable()
export class DiscoveryHttpAdapter implements DiscoveryHttpPort {
  async fenajuPage(page: number) {
    const { data } = await fetchJson<any>(`${BASE_FENAJU}?page=${page}&limit=20`, { gapMs: 300 });
    return data;
  }

  async probe(url: string, timeout = 12000) {
    const res = await request(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'pt-BR,pt;q=0.9' },
      headersTimeout: timeout,
      bodyTimeout: timeout,
      dispatcher: agente,
    });
    return { status: res.statusCode, body: await res.body.text() };
  }
}
