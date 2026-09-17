import { useMemo } from 'react';
import { X } from 'lucide-react';
import type { Facets } from '@/lib/types';
import { LABEL_ASSET } from '@/lib/labels';
import { type EstadoBusca, type MultiId, MULTIS } from '@/lib/filtros';
import { MultiSelect } from './MultiSelect';

interface Props {
  estado: EstadoBusca;
  facetas: Facets | null;
  rotulosServidor: Record<string, Record<string, string>>;
  aoMudar: (patch: Partial<EstadoBusca>) => void;
  aoLimpar: () => void;
  /** Só no celular: a lateral vira gaveta e precisa de um jeito de fechar. */
  aoFechar?: () => void;
}

export function FilterSidebar({ estado, facetas, rotulosServidor, aoMudar, aoLimpar, aoFechar }: Props) {
  const ehImovel = estado.assetType === 'imovel';

  /**
   * Taxonomia FIXA, não descoberta: o usuário precisa ver "Imóvel (0)" enquanto
   * não há imóvel no índice, senão a opção nem existe no select e escolhê-la
   * falha em silêncio. Veículo e imóvel nunca somem, tenham contagem ou não.
   */
  const opcoesBem = useMemo(() => {
    const contas = new Map((facetas?.assetTypes ?? []).map((r) => [String(r.value), r.count]));
    return Object.entries(LABEL_ASSET)
      .map(([v, l]) => ({ v, l, n: contas.get(v) ?? 0 }))
      .filter((o) => o.n > 0 || o.v === estado.assetType || o.v === 'veiculo' || o.v === 'imovel')
      .sort((a, b) => b.n - a.n || a.l.localeCompare(b.l, 'pt-BR'));
  }, [facetas, estado.assetType]);

  function mudarMulti(id: MultiId, valores: string[]) {
    const patch: Partial<EstadoBusca> = {
      multi: { ...estado.multi, [id]: valores },
      page: 1,
    };
    // Mexer no estado invalida a cidade escolhida: "Curitiba" com PR desmarcado
    // vira filtro invisível que zera o resultado sem dizer por quê.
    if (id === 'uf') patch.multi = { ...patch.multi!, city: [] };
    aoMudar(patch);
  }

  function mudarBem(v: string) {
    // Filtro escondido que continua valendo devolve resultado vazio sem
    // explicação: ao trocar de bem, a seleção do outro lado é zerada.
    const oposto: MultiId = v === 'imovel' ? 'vehicleType' : 'propertyType';
    aoMudar({
      assetType: v,
      multi: { ...estado.multi, [oposto]: [] },
      // Imóvel não tem ano de modelo; deixar o valor vale como filtro invisível.
      ...(v === 'imovel' ? { yearMin: '', yearMax: '' } : {}),
      page: 1,
    });
  }

  /**
   * Cada filtro aparece quando é APLICÁVEL, não só quando é o lado escolhido:
   * sem filtro de bem a lista mistura os dois, e escolher "Apartamento" já
   * restringe a imóvel por si. Esconder um dos dois seria esconder metade.
   */
  function visivel(id: MultiId): boolean {
    if (id === 'vehicleType') return !ehImovel;
    if (id === 'propertyType') return estado.assetType !== 'veiculo';
    // Cidade só depois do estado: são 1.552 no índice, e uma lista desse
    // tamanho não ajuda ninguém a achar Curitiba.
    if (id === 'city') return estado.multi.uf.length > 0;
    return true;
  }

  return (
    <aside className="filtros" aria-label="Filtros de busca">
      <div className="filtros-topo">
        <h2>Filtros</h2>
        {aoFechar && (
          <button type="button" className="ico-fechar" onClick={aoFechar} aria-label="Fechar filtros">
            <X size={18} aria-hidden />
          </button>
        )}
      </div>

      <div className="f-group">
        <label className="f-label" htmlFor="assetType">
          Tipo de leilão
        </label>
        <select id="assetType" value={estado.assetType} onChange={(e) => mudarBem(e.target.value)}>
          <option value="">Todos</option>
          {opcoesBem.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l} ({o.n.toLocaleString('pt-BR')})
            </option>
          ))}
        </select>
      </div>

      {MULTIS.filter((d) => visivel(d.id)).map((def) => (
        <MultiSelect
          key={def.id}
          def={def}
          linhas={facetas?.[def.faceta] ?? []}
          escolhidos={estado.multi[def.id]}
          rotulosServidor={rotulosServidor[def.id] ?? {}}
          aoMudar={(v) => mudarMulti(def.id, v)}
        />
      ))}

      <p className="f-nota">
        Nem toda fonte publica o leiloeiro; escolher um deixa de fora os lotes sem essa informação.
      </p>

      <div className="f-group">
        <span className="f-label">Faixa de preço (R$)</span>
        <div className="f-row">
          <input
            type="number" inputMode="numeric" placeholder="min" aria-label="Preço mínimo em reais"
            value={estado.priceMin}
            onChange={(e) => aoMudar({ priceMin: e.target.value, page: 1 })}
          />
          <input
            type="number" inputMode="numeric" placeholder="max" aria-label="Preço máximo em reais"
            value={estado.priceMax}
            onChange={(e) => aoMudar({ priceMax: e.target.value, page: 1 })}
          />
        </div>
      </div>

      {!ehImovel && (
        <div className="f-group">
          <span className="f-label">Ano do modelo</span>
          <div className="f-row">
            <input
              type="number" inputMode="numeric" placeholder="de" aria-label="Ano do modelo, de"
              value={estado.yearMin}
              onChange={(e) => aoMudar({ yearMin: e.target.value, page: 1 })}
            />
            <input
              type="number" inputMode="numeric" placeholder="até" aria-label="Ano do modelo, até"
              value={estado.yearMax}
              onChange={(e) => aoMudar({ yearMax: e.target.value, page: 1 })}
            />
          </div>
        </div>
      )}

      <div className="f-group">
        <label className="chk">
          <input
            type="checkbox" checked={estado.onlyWithDate}
            onChange={(e) => aoMudar({ onlyWithDate: e.target.checked, page: 1 })}
          />
          <span>Só com data de leilão</span>
        </label>
        <label className="chk">
          <input
            type="checkbox" checked={estado.onlyWithPhoto}
            onChange={(e) => aoMudar({ onlyWithPhoto: e.target.checked, page: 1 })}
          />
          <span>Só com foto</span>
        </label>
      </div>

      <button type="button" className="btn-clear" onClick={aoLimpar}>
        Limpar filtros
      </button>
    </aside>
  );
}
