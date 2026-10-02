import { X } from 'lucide-react';
import { LABEL_ASSET } from '@/lib/labels';
import { type EstadoBusca, type MultiId, MULTIS, rotuloOpcao } from '@/lib/filtros';
import { money } from '@/lib/format';

export interface Ativo {
  chave: string;
  texto: string;
  remover: (e: EstadoBusca) => Partial<EstadoBusca>;
}

const PRAZO: Record<string, string> = { hoje: 'Encerra hoje', '7d': 'Encerra em 7 dias' };

/** Cada filtro que pesa na busca, com o jeito de desfazê-lo. A faixa de alerta lê a mesma lista. */
export function filtrosAtivos(e: EstadoBusca, rotulos: Record<string, Record<string, string>>): Ativo[] {
  const a: Ativo[] = [];
  if (e.q.trim()) a.push({ chave: 'q', texto: `“${e.q.trim()}”`, remover: () => ({ q: '', page: 1 }) });
  if (e.assetType) a.push({ chave: 'bem', texto: LABEL_ASSET[e.assetType] ?? e.assetType, remover: () => ({ assetType: '', page: 1 }) });
  for (const def of MULTIS) {
    for (const v of e.multi[def.id]) {
      const id: MultiId = def.id;
      a.push({
        chave: `${id}:${v}`,
        texto: rotulos[id]?.[v] ?? rotuloOpcao(def, { value: v, count: 0 }),
        remover: (x) => ({
          multi: { ...x.multi, [id]: x.multi[id].filter((y) => y !== v), ...(id === 'uf' ? { city: [] } : {}) },
          page: 1,
        }),
      });
    }
  }
  if (e.priceMin || e.priceMax) {
    const min = e.priceMin ? money(Number(e.priceMin)) : null;
    const max = e.priceMax ? money(Number(e.priceMax)) : null;
    const texto = min && max ? `${min} a ${max}` : max ? `Até ${max}` : `A partir de ${min}`;
    a.push({ chave: 'preco', texto, remover: () => ({ priceMin: '', priceMax: '', page: 1 }) });
  }
  if (e.yearMin || e.yearMax) {
    a.push({ chave: 'ano', texto: `Ano ${e.yearMin || '…'}–${e.yearMax || '…'}`, remover: () => ({ yearMin: '', yearMax: '', page: 1 }) });
  }
  if (e.prazo) a.push({ chave: 'prazo', texto: PRAZO[e.prazo], remover: () => ({ prazo: '', page: 1 }) });
  if (e.abaixo) a.push({ chave: 'abaixo', texto: 'Abaixo da avaliação', remover: () => ({ abaixo: false, page: 1 }) });
  if (e.onlyWithPhoto) a.push({ chave: 'foto', texto: 'Com foto', remover: () => ({ onlyWithPhoto: false, page: 1 }) });
  if (e.onlyWithDate) a.push({ chave: 'data', texto: 'Com data de leilão', remover: () => ({ onlyWithDate: false, page: 1 }) });
  if (e.local) {
    const n = e.local.split(';').filter(Boolean).length;
    a.push({ chave: 'local', texto: n > 1 ? `${n} pontos do mapa` : 'Ponto do mapa', remover: () => ({ local: '', page: 1 }) });
  }
  return a;
}

export function FiltrosAtivos({ ativos, estado, aoMudar, aoLimpar }: {
  ativos: Ativo[];
  estado: EstadoBusca;
  aoMudar: (patch: Partial<EstadoBusca>) => void;
  aoLimpar: () => void;
}) {
  if (!ativos.length) return null;
  return (
    <div className="ativos-linha" aria-label="Filtros ativos">
      {ativos.map((a) => (
        <button key={a.chave} type="button" className="chip-ativo" onClick={() => aoMudar(a.remover(estado))}>
          <span className="chip-txt">{a.texto}</span>
          <X size={13} aria-hidden />
          <span className="sr-only">remover filtro</span>
        </button>
      ))}
      {ativos.length > 1 && (
        <button type="button" className="chip-limpar" onClick={aoLimpar}>Limpar tudo</button>
      )}
    </div>
  );
}
