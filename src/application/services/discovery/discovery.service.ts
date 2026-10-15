import { Inject, Injectable } from '@nestjs/common';
import { acumulaSiteFenaju, analisarHtmlSite, conectorDaPlataforma, host, hostDoEmail, requirePersistedFenaju, type ResultadoFenaju, type ResultadoSonda } from '../../../domain/discovery/discovery.js';
import type { DiscoveryHttpPort } from '../../../infra/discovery/discovery.http.js';
import type { DiscoveryRepositoryPort } from '../../../infra/discovery/discovery.repository.js';
import { DISCOVERY_HTTP, DISCOVERY_REPOSITORY } from '../../modules/discovery/discovery.tokens.js';

@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly repository: DiscoveryRepositoryPort,
    @Inject(DISCOVERY_HTTP) private readonly http: DiscoveryHttpPort,
  ) {}

  async descobrirFenaju(): Promise<ResultadoFenaju> {
    const todos: any[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await this.http.fenajuPage(page);
      const itens: any[] = data?.data ?? [];
      todos.push(...itens);
      totalPages = Number(data?.totalPages ?? 1);
      if (!itens.length) break;
      page++;
    } while (page <= totalPages);

    let comLeilaoBr = 0;
    const sites = new Map<string, { ufs: Set<string>; n: number }>();

    for (const l of todos) {
      const declarado = host(l.dominio);
      const domLeilao = host(l.dominio_url);
      const doEmail = declarado ?? domLeilao ? null : hostDoEmail(l.email);
      // domínio declarado > dominio_url > domínio do e-mail, conforme a ordem legada.
      const domain = declarado ?? domLeilao ?? doEmail;
      if (domLeilao) comLeilaoBr++;
      const uf = String(l.juntaUF ?? '').toUpperCase().slice(0, 2) || null;

      const persistedRow = await this.repository.upsertAuctioneer(
        [String(l.id), l.nome ?? '', l.matricula ?? null, l.juntaSigla ?? null, uf, l.situacao ?? null,
          domain, declarado ? 'declarado' : domLeilao ? 'dominio_url' : doEmail ? 'email' : null,
          l.anoPosse ?? null, l.credenciamento ?? null, l.isAssociado ?? null, l.nivel ?? null, domLeilao],
      );
      const persisted = requirePersistedFenaju(persistedRow, String(l.id));

      if (!/regular/i.test(String(l.situacao ?? ''))) continue;
      acumulaSiteFenaju(sites, persisted?.domain ?? null, uf);
      if (domLeilao && domLeilao !== persisted?.domain) acumulaSiteFenaju(sites, domLeilao, uf);
    }

    for (const [domain, info] of sites) await this.repository.upsertSite(domain, info.n, [...info.ufs]);
    const { total, pendentes } = await this.repository.siteCounts();
    return { leiloeiros: todos.length, comLeilaoBr, sitesNoCatalogo: total, aSondar: pendentes };
  }

  private async sondar(domain: string) {
    const controlePath = '/__nao-existe-radar-' + Date.now();
    for (const esquema of ['https', 'http'] as const) {
      try {
        const home = await this.http.probe(`${esquema}://${domain}/`);
        let controle: { status: number; body: string } | null = null;
        try { controle = await this.http.probe(`${esquema}://${domain}${controlePath}`, 8000); }
        catch { /* controle falhar é bom sinal: o servidor discrimina */ }
        const indiscriminado = controle !== null && controle.status === home.status && Math.abs(controle.body.length - home.body.length) < 200;
        return { status: home.status, ...analisarHtmlSite(home.body, indiscriminado) };
      } catch (err: any) {
        if (esquema === 'http') return { status: 0, hasLots: null, platform: null, title: null, note: String(err?.code ?? err?.message ?? 'erro').slice(0, 60) };
      }
    }
    return { status: 0, hasLots: null, platform: null, title: null, note: 'inalcançável' };
  }

  private async temLotesColetados(domain: string) { return this.repository.hasLots(domain); }

  async sondarSites(limite = 150, concorrencia = 12): Promise<ResultadoSonda> {
    const alvos = await this.repository.sites(limite);
    const antes = new Map(alvos.map((a) => [a.domain, a.platform]));
    const mudaram: string[] = [];
    let noAr = 0;
    let comPlataforma = 0;
    const fila = [...alvos];
    await Promise.all(Array.from({ length: concorrencia }, async () => {
      while (fila.length) {
        const alvo = fila.shift();
        if (!alvo) break;
        const r = await this.sondar(alvo.domain);
        const det = conectorDaPlataforma(antes.get(alvo.domain), r.platform);
        const hasLots = r.hasLots === false && (await this.temLotesColetados(alvo.domain)) ? true : r.hasLots;
        await this.repository.updateProbe(alvo.domain, { ...r, hasLots }, det);
        if (r.status === 200) noAr++;
        if (r.platform) comPlataforma++;
        const anterior = antes.get(alvo.domain) ?? null;
        if (anterior !== r.platform) mudaram.push(`${alvo.domain}: ${anterior ?? '—'} → ${r.platform ?? '—'}`);
      }
    }));
    return { sondados: alvos.length, noAr, comPlataforma, mudaramDePlataforma: mudaram };
  }

  async sondarDominios(dominios: string[], concorrencia = 6): Promise<ResultadoSonda> {
    const unicos = [...new Set(dominios.map((d) => d.trim().toLowerCase()).filter(Boolean))];
    const existentes = await this.repository.sitesByDomains(unicos);
    const antes = new Map(existentes.map((a) => [a.domain, a.platform]));
    const fila = existentes.map((e) => e.domain);
    const mudaram: string[] = [];
    let noAr = 0;
    let comPlataforma = 0;
    await Promise.all(Array.from({ length: concorrencia }, async () => {
      while (fila.length) {
        const domain = fila.shift();
        if (!domain) break;
        const r = await this.sondar(domain);
        const det = conectorDaPlataforma(antes.get(domain), r.platform);
        const hasLots = r.hasLots === false && (await this.temLotesColetados(domain)) ? true : r.hasLots;
        await this.repository.updateProbe(domain, { ...r, hasLots }, det);
        if (r.status === 200) noAr++;
        if (r.platform) comPlataforma++;
        const anterior = antes.get(domain) ?? null;
        if (anterior !== r.platform) mudaram.push(`${domain}: ${anterior ?? '—'} → ${r.platform ?? '—'}`);
      }
    }));
    return { sondados: fila.length + existentes.length, noAr, comPlataforma, mudaramDePlataforma: mudaram };
  }

  async rodarDescoberta(qual: 'fenaju' | 'sonda', limite?: number, concorrencia?: number) {
    const runId = await this.repository.startRun(qual === 'fenaju' ? 'fenaju' : 'sonda-sites', 'discover');
    try {
      if (qual === 'fenaju') {
        const r = await this.descobrirFenaju();
        await this.repository.finishRun(runId, { ok: true, fetched: r.leiloeiros, upserted: r.sitesNoCatalogo, skipped: r.aSondar });
        return r;
      }
      const r = await this.sondarSites(limite, concorrencia);
      await this.repository.finishRun(runId, { ok: true, fetched: r.sondados, upserted: r.comPlataforma, skipped: r.sondados - r.noAr });
      return r;
    } catch (err: any) {
      await this.repository.finishRun(runId, { ok: false, error: String(err?.message ?? err) });
      throw err;
    }
  }
}
