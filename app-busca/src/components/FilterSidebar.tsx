import { useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { FacetRow, Facets } from '@/lib/types';
import { type DefMulti, type EstadoBusca, type MultiId, defDe, rotuloOpcao } from '@/lib/filtros';
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

const FAIXAS: Array<[string, string, string]> = [
  ['Até R$ 10 mil', '', '10000'],
  ['R$ 10 a 50 mil', '10000', '50000'],
  ['R$ 50 a 150 mil', '50000', '150000'],
  ['Acima de R$ 150 mil', '150000', ''],
];
const PRAZOS: Array<[EstadoBusca['prazo'], string]> = [['', 'Qualquer data'], ['hoje', 'Encerra hoje'], ['7d', 'Nos próximos 7 dias']];
const VISIVEIS = 6;

function Secao({ titulo, aberta = true, children }: { titulo: string; aberta?: boolean; children: ReactNode }) {
  return (
    <details className="f-secao" open={aberta}>
      <summary>{titulo}<ChevronDown size={16} aria-hidden /></summary>
      <div className="f-secao-corpo">{children}</div>
    </details>
  );
}

/**
 * Faceta curta vira lista de caixas à vista: um clique a menos que o dropdown.
 * O que está marcado aparece mesmo com contagem zero, senão vira filtro
 * invisível que zera o resultado sem dizer por quê.
 */
function ListaOpcoes({ def, linhas, escolhidos, aoMudar }: {
  def: DefMulti; linhas: FacetRow[]; escolhidos: string[]; aoMudar: (v: string[]) => void;
}) {
  const [todas, setTodas] = useState(false);
  const opcoes = [
    ...linhas,
    ...escolhidos.filter((v) => !linhas.some((l) => String(l.value) === v)).map((v) => ({ value: v, count: 0 })),
  ];
  if (!opcoes.length) return <p className="f-vazio">Nenhuma opção nesta busca.</p>;
  const mostrar = todas ? opcoes : opcoes.slice(0, VISIVEIS);
  return (
    <div className="f-opcoes" role="group" aria-label={def.titulo}>
      {mostrar.map((l) => {
        const v = String(l.value);
        const on = escolhidos.includes(v);
        return (
          <label key={v} className="f-op">
            <input
              type="checkbox"
              checked={on}
              onChange={() => aoMudar(on ? escolhidos.filter((x) => x !== v) : [...escolhidos, v])}
            />
            <span className="f-op-nome">{rotuloOpcao(def, l)}</span>
            <span className="f-op-n mono">{l.count.toLocaleString('pt-BR')}</span>
          </label>
        );
      })}
      {opcoes.length > VISIVEIS && (
        <button type="button" className="f-mais" onClick={() => setTodas((v) => !v)}>
          {todas ? 'Mostrar menos' : `Ver todas (${opcoes.length})`}
        </button>
      )}
    </div>
  );
}

export function FilterSidebar({ estado, facetas, rotulosServidor, aoMudar, aoLimpar, aoFechar }: Props) {
  const ehImovel = estado.assetType === 'imovel';

  function mudarMulti(id: MultiId, valores: string[]) {
    const patch: Partial<EstadoBusca> = { multi: { ...estado.multi, [id]: valores }, page: 1 };
    // Mexer no estado invalida a cidade escolhida: "Curitiba" com PR desmarcado
    // vira filtro invisível que zera o resultado sem dizer por quê.
    if (id === 'uf') patch.multi = { ...patch.multi!, city: [] };
    aoMudar(patch);
  }

  const lista = (id: MultiId) => (
    <ListaOpcoes
      def={defDe(id)}
      linhas={facetas?.[defDe(id).faceta] ?? []}
      escolhidos={estado.multi[id]}
      aoMudar={(v) => mudarMulti(id, v)}
    />
  );
  const multi = (id: MultiId) => (
    <MultiSelect
      def={defDe(id)}
      linhas={facetas?.[defDe(id).faceta] ?? []}
      escolhidos={estado.multi[id]}
      rotulosServidor={rotulosServidor[id] ?? {}}
      aoMudar={(v) => mudarMulti(id, v)}
    />
  );
  const sw = (rotulo: string, ligado: boolean, aoTrocar: (v: boolean) => void) => (
    <label className="f-sw">
      <span>{rotulo}</span>
      <input type="checkbox" role="switch" checked={ligado} onChange={(e) => aoTrocar(e.target.checked)} />
    </label>
  );

  return (
    <aside className="filtros" aria-label="Filtros de busca">
      <div className="filtros-topo">
        <h2>Filtros</h2>
        <button type="button" className="f-limpar" onClick={aoLimpar}>Limpar tudo</button>
        {aoFechar && (
          <button type="button" className="ico-fechar" onClick={aoFechar} aria-label="Fechar filtros">
            <X size={18} aria-hidden />
          </button>
        )}
      </div>

      <Secao titulo="Faixa de preço">
        <div className="f-faixa">
          <input
            type="number" inputMode="numeric" placeholder="Mín. R$" aria-label="Preço mínimo em reais"
            value={estado.priceMin}
            onChange={(e) => aoMudar({ priceMin: e.target.value, page: 1 })}
          />
          <span aria-hidden>–</span>
          <input
            type="number" inputMode="numeric" placeholder="Máx. R$" aria-label="Preço máximo em reais"
            value={estado.priceMax}
            onChange={(e) => aoMudar({ priceMax: e.target.value, page: 1 })}
          />
        </div>
        <div className="f-atalhos">
          {FAIXAS.map(([nome, min, max]) => {
            const on = estado.priceMin === min && estado.priceMax === max;
            return (
              <button
                key={nome} type="button" className="f-atalho" aria-pressed={on}
                onClick={() => aoMudar({ priceMin: on ? '' : min, priceMax: on ? '' : max, page: 1 })}
              >
                {nome}
              </button>
            );
          })}
        </div>
      </Secao>

      <Secao titulo="Encerramento">
        <div className="f-opcoes" role="radiogroup" aria-label="Encerramento">
          {PRAZOS.map(([v, nome]) => (
            <label key={v || 'qualquer'} className="f-op radio">
              <input type="radio" name="prazo" checked={estado.prazo === v} onChange={() => aoMudar({ prazo: v, page: 1 })} />
              <span className="f-op-nome">{nome}</span>
            </label>
          ))}
        </div>
      </Secao>

      <Secao titulo="Valor e mídia">
        {sw('Abaixo da avaliação', estado.abaixo, (v) => aoMudar({ abaixo: v, page: 1 }))}
        {sw('Somente com foto', estado.onlyWithPhoto, (v) => aoMudar({ onlyWithPhoto: v, page: 1 }))}
        {sw('Somente com data de leilão', estado.onlyWithDate, (v) => aoMudar({ onlyWithDate: v, page: 1 }))}
      </Secao>

      <Secao titulo="Situação do bem">{lista('docType')}</Secao>

      {!ehImovel && (
        <Secao titulo="Veículo">
          {lista('vehicleType')}
          <span className="f-sub">Ano do modelo</span>
          <div className="f-faixa">
            <input
              type="number" inputMode="numeric" placeholder="De" aria-label="Ano do modelo, de"
              value={estado.yearMin}
              onChange={(e) => aoMudar({ yearMin: e.target.value, page: 1 })}
            />
            <span aria-hidden>–</span>
            <input
              type="number" inputMode="numeric" placeholder="Até" aria-label="Ano do modelo, até"
              value={estado.yearMax}
              onChange={(e) => aoMudar({ yearMax: e.target.value, page: 1 })}
            />
          </div>
        </Secao>
      )}

      {estado.assetType !== 'veiculo' && <Secao titulo="Imóvel" aberta={ehImovel}>{lista('propertyType')}</Secao>}

      <Secao titulo="Localização">
        {multi('uf')}
        {/* Cidade só depois do estado: são 1.552 no índice. */}
        {estado.multi.uf.length > 0 && multi('city')}
      </Secao>

      <Secao titulo="Leilão" aberta={false}>
        <span className="f-sub">Status</span>
        {lista('status')}
        <span className="f-sub">Origem do lote</span>
        {lista('sellerType')}
        <span className="f-sub">Fonte</span>
        {lista('sourceId')}
      </Secao>

      <Secao titulo="Leiloeiro e comitente" aberta={false}>
        {multi('auctioneer')}
        {multi('seller')}
        <p className="f-nota">Nem toda fonte publica o leiloeiro; escolher um deixa de fora os lotes sem essa informação.</p>
      </Secao>
    </aside>
  );
}
