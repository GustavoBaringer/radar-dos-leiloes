export type Veredito = 'aberto' | 'agendado' | 'encerrado' | 'sumiu' | 'indeterminado';

export interface LoteParaVerificar {
  id: number;
  externalId: string | null;
  lotUrl: string | null;
  categoria: string | null;
}

export interface Resultado {
  veredito: Veredito;
  sinal: string;
  fimUtc?: string | null;
}

/** IO-independent contract: concrete source verifiers live in infrastructure. */
export interface Verificador {
  porHost: boolean;
  verificar(host: string, lotes: LoteParaVerificar[], buscar?: any): Promise<Map<number, Resultado>>;
}

export function fimPrevisto(html: string): string | null {
  const m = /<dt>\s*Encerra em\s*<\/dt>[\s\S]{0,200}?<dd[^>]*>[\s\S]{0,60}?(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/i.exec(html);
  if (!m) return null;
  const [, d, mes, a, h = '00', min = '00'] = m;
  const ts = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

export function pracas(html: string): number[] {
  const t: number[] = [];
  for (const m of html.matchAll(/Data\s+\d?[ºo]?\s*Leil[ãa]o:?\s*<\/strong>?\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/gi)) {
    const [, d, mes, a, h = '23', min = '59'] = m;
    const ts = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
    if (Number.isFinite(ts)) t.push(ts);
  }
  return t.sort((a, b) => b - a);
}

export function soleonResposta(lote: LoteParaVerificar, status: number, body: string, agora: () => number): Resultado {
  if (status === 404 || status === 410) return { veredito: 'sumiu', sinal: `HTTP ${status}` };
  if (status !== 200) return { veredito: 'indeterminado', sinal: `HTTP ${status}` };
  const m = /id="status_lote"[\s\S]{0,400}?class="label_lote ([a-z_]+)"[^>]*>([^<]*)</i.exec(body);
  if (!m) {
    const alt = /<div[^>]*btn-block[^>]*>\s*<strong>\s*(ENCERRADO|ARREMATADO|VENDIDO|CANCELADO)\s*<\/strong>/i.exec(body);
    return alt ? { veredito: 'encerrado', sinal: alt[1].toUpperCase() } : { veredito: 'indeterminado', sinal: 'sem marcador de status' };
  }
  const classe = m[1].toLowerCase();
  const texto = m[2].trim();
  if (/aberto/.test(classe)) return { veredito: 'aberto', sinal: texto };
  if (/aguard/.test(classe)) return { veredito: 'agendado', sinal: texto };
  if (/encerrad|sustad|arrematad|vendid|cancelad|suspens|deserto|retirad/.test(classe)) return { veredito: 'encerrado', sinal: texto };
  if (/condicional/.test(classe)) return { veredito: 'encerrado', sinal: texto };
  if (/sem_licitante|nao_vendido/.test(classe)) {
    const ps = pracas(body);
    return ps.some((t) => t > agora())
      ? { veredito: 'agendado', sinal: `${texto} (2ª praça marcada)` }
      : /<div[^>]*btn-block[^>]*>\s*<strong>\s*ENCERRADO\s*<\/strong>/i.test(body)
        ? { veredito: 'encerrado', sinal: `${texto} (sem praça futura)` }
        : ps.length
          ? { veredito: 'encerrado', sinal: `${texto} (praças esgotadas, última em ${new Date(ps[0]).toISOString().slice(0, 10)})` }
          : { veredito: 'indeterminado', sinal: `${texto}: nenhuma data de praça encontrada` };
  }
  return { veredito: 'indeterminado', sinal: `${classe}: ${texto}` };
}

export function vlanceResposta(lotes: LoteParaVerificar[], respondeu: boolean, vivos: Map<string, string>) {
  const saida = new Map<number, Resultado>();
  for (const l of lotes) {
    if (!respondeu) { saida.set(l.id, { veredito: 'indeterminado', sinal: 'API do host não respondeu' }); continue; }
    const idLote = String(l.lotUrl?.match(/\/lote\/(\d+)/)?.[1] ?? '');
    if (!idLote) { saida.set(l.id, { veredito: 'indeterminado', sinal: 'sem id de lote na URL' }); continue; }
    const st = vivos.get(idLote);
    if (st) saida.set(l.id, { veredito: /encerr|vendid|arremat/i.test(st) ? 'encerrado' : 'aberto', sinal: st });
    else saida.set(l.id, { veredito: 'encerrado', sinal: 'ausente do catálogo ativo da API' });
  }
  return saida;
}

export function leiloResposta(lotes: LoteParaVerificar[], completas: Set<string>, vivos: Set<string>) {
  const saida = new Map<number, Resultado>();
  for (const l of lotes) {
    const cat = l.categoria ?? '';
    if (!completas.has(cat)) { saida.set(l.id, { veredito: 'indeterminado', sinal: `categoria "${cat}" não varrida por completo` }); continue; }
    const ext = String(l.externalId ?? '');
    saida.set(l.id, vivos.has(ext)
      ? { veredito: 'aberto', sinal: 'presente na varredura da categoria' }
      : { veredito: 'encerrado', sinal: 'ausente da varredura completa da categoria' });
  }
  return saida;
}

export function freitasResposta(lote: LoteParaVerificar, status: number, data: any): Resultado {
  if (status !== 200 || !data) return { veredito: 'indeterminado', sinal: `HTTP ${status}` };
  if (data.success === false) return { veredito: 'sumiu', sinal: String(data.message ?? 'success:false') };
  const nome = String(data.message?.nome ?? '').trim();
  const n = nome.toLowerCase();
  if (!n) return { veredito: 'indeterminado', sinal: 'sem nome de status' };
  if (/aberto/.test(n)) return { veredito: 'aberto', sinal: nome };
  if (/agendad|loteament/.test(n)) return { veredito: 'agendado', sinal: nome };
  if (/vendid|arrematad|encerrad|cancelad|retirad|suspens|deserto/.test(n)) return { veredito: 'encerrado', sinal: nome };
  if (data.message?.recebeLance === false) return { veredito: 'encerrado', sinal: nome };
  return { veredito: 'indeterminado', sinal: nome };
}

export function hastapublicaResposta(lote: LoteParaVerificar, status: number, body: string, agora: () => number): Resultado {
  if (status === 404 || status === 410) return { veredito: 'sumiu', sinal: `HTTP ${status}` };
  if (status !== 200) return { veredito: 'indeterminado', sinal: `HTTP ${status}` };
  const estado = body.match(/<dt>\s*Status do Item\s*<\/dt>\s*<dd[^>]*>([^<]{1,80})<\/dd>/i)?.[1]?.trim();
  const idDoLote = lote.externalId ?? lote.lotUrl?.match(/\/lote\/(\d+)/)?.[1] ?? null;
  const paginaDoLote = !idDoLote || new RegExp(`/lote/${idDoLote}/`).test(body);
  if (!paginaDoLote && /nenhum\s+lote\s+(para\s+exibir|dispon[ií]vel|encontrado)/i.test(body)) return { veredito: 'sumiu', sinal: `fonte diz que o lote ${idDoLote} não existe mais` };
  const fim = fimPrevisto(body);
  if (!estado) return { veredito: 'indeterminado', sinal: 'sem "Status do Item"', fimUtc: fim };
  const t = estado.toLowerCase();
  const semLicitante = /sem licitante|n[aã]o vendid|houve lance|deserto/.test(t);
  const r0: Omit<Resultado, 'veredito'> = { sinal: estado, ...(fim ? { fimUtc: fim } : {}) };
  if (!semLicitante && /recebendo|em leila[ãa]o|em andamento|lance|proposta|aberto|habilitado/.test(t)) return { veredito: 'aberto', ...r0 };
  if (!semLicitante && /aguard|inicio|breve|a abrir/.test(t)) return { veredito: 'agendado', ...r0 };
  if (/arrematad|vendid|encerrad|cancelad|suspens|retirad|sustad/.test(t)) return { veredito: 'encerrado', ...r0 };
  if (semLicitante && fim) return { veredito: Date.parse(fim) > agora() ? 'agendado' : 'encerrado', sinal: `${estado} (prazo ${fim})`, fimUtc: fim };
  return { veredito: 'indeterminado', ...r0 };
}
