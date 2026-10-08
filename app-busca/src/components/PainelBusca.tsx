import { Search } from 'lucide-react';
import type { Facets } from '@/lib/types';
import { LABEL_VEHICLE } from '@/lib/labels';
import { type EstadoBusca, patchDoBem } from '@/lib/filtros';

interface Props {
  estado: EstadoBusca;
  facetas: Facets | null;
  total: number | null;
  /** O texto digitado ainda não virou busca: a linha sob o campo conta o segundo de espera. */
  esperando: boolean;
  aoMudar: (patch: Partial<EstadoBusca>) => void;
  aoEnviar: () => void;
}

const VARIOS = '__varios';
const PRECOS = ['5000', '10000', '25000', '50000', '100000', '200000'];

function tipoAtualDe(e: EstadoBusca): string {
  const tipos = e.multi.vehicleType;
  if (e.assetType === 'imovel') return 'imovel';
  if (tipos.length > 1) return VARIOS;
  if (tipos.length === 1) return tipos[0];
  return e.assetType === 'veiculo' ? 'veiculo' : '';
}

function precoAtualDe(e: EstadoBusca): string {
  if (!e.priceMin && !e.priceMax) return '';
  return !e.priceMin && PRECOS.includes(e.priceMax) ? e.priceMax : VARIOS;
}

export function PainelBusca({ estado, facetas, total, esperando, aoMudar, aoEnviar }: Props) {
  const tipoAtual = tipoAtualDe(estado);
  const ufs = estado.multi.uf;
  const ufAtual = ufs.length > 1 ? VARIOS : (ufs[0] ?? '');
  const precoAtual = precoAtualDe(estado);
  const veiculoEscolhido = estado.assetType === 'veiculo' || (!estado.assetType && estado.multi.vehicleType.length > 0);
  const aba = estado.assetType === 'imovel' ? 'imovel' : veiculoEscolhido ? 'veiculo' : '';

  function mudarTipo(v: string) {
    if (v === VARIOS) return;
    if (v === 'imovel' || v === 'veiculo' || v === '') {
      aoMudar(patchDoBem({ ...estado, multi: { ...estado.multi, vehicleType: [] } }, v));
      return;
    }
    aoMudar({ assetType: '', multi: { ...estado.multi, vehicleType: [v], propertyType: [] }, page: 1 });
  }

  return (
    <form className="pb" role="search" onSubmit={(e) => { e.preventDefault(); aoEnviar(); }}>
      <div className="pb-abas" role="group" aria-label="Tipo de bem">
        {([['', 'Tudo'], ['veiculo', 'Veículos'], ['imovel', 'Imóveis']] as const).map(([v, nome]) => (
          <button key={v || 'tudo'} type="button" aria-pressed={aba === v} onClick={() => aba !== v && mudarTipo(v)}>
            {nome}
          </button>
        ))}
      </div>
      <div className="pb-linha">
        <div className="pb-campo pb-texto">
          <label htmlFor="q">Modelo, marca ou cidade</label>
          <input
            id="q" type="search" enterKeyHint="search" autoComplete="off" autoCapitalize="none"
            placeholder="Ex.: Honda CG, Hilux, apartamento Salvador"
            value={estado.q}
            onChange={(e) => aoMudar({ q: e.target.value })}
          />
          {esperando && <i key={estado.q} className="pb-espera" aria-hidden />}
        </div>
        <div className="pb-campo">
          <label htmlFor="pb-tipo">Tipo</label>
          <select id="pb-tipo" value={tipoAtual} onChange={(e) => mudarTipo(e.target.value)}>
            <option value="">Todos os tipos</option>
            <option value="veiculo">Todos os veículos</option>
            {(facetas?.vehicleTypes ?? []).slice(0, 10).map((r) => (
              <option key={r.value} value={r.value}>
                {LABEL_VEHICLE[r.value] ?? r.value} ({r.count.toLocaleString('pt-BR')})
              </option>
            ))}
            {tipos(tipoAtual, facetas)}
            <option value="imovel">Imóveis</option>
            {tipoAtual === VARIOS && <option value={VARIOS}>Vários tipos</option>}
          </select>
        </div>
        <div className="pb-campo">
          <label htmlFor="pb-uf">Estado</label>
          <select
            id="pb-uf" value={ufAtual}
            onChange={(e) => e.target.value !== VARIOS && aoMudar({ multi: { ...estado.multi, uf: e.target.value ? [e.target.value] : [], city: [] }, page: 1 })}
          >
            <option value="">Todo o Brasil</option>
            {(facetas?.states ?? []).map((r) => (
              <option key={r.value} value={r.value}>{r.value} ({r.count.toLocaleString('pt-BR')})</option>
            ))}
            {ufAtual && ufAtual !== VARIOS && !(facetas?.states ?? []).some((r) => r.value === ufAtual) && <option value={ufAtual}>{ufAtual}</option>}
            {ufAtual === VARIOS && <option value={VARIOS}>Vários estados</option>}
          </select>
        </div>
        <div className="pb-campo">
          <label htmlFor="pb-preco">Preço até</label>
          <select
            id="pb-preco" value={precoAtual}
            onChange={(e) => e.target.value !== VARIOS && aoMudar({ priceMin: '', priceMax: e.target.value, page: 1 })}
          >
            <option value="">Qualquer valor</option>
            {PRECOS.map((p) => <option key={p} value={p}>Até R$ {(Number(p) / 1000).toLocaleString('pt-BR')} mil</option>)}
            {precoAtual === VARIOS && <option value={VARIOS}>Faixa personalizada</option>}
          </select>
        </div>
        <button type="submit" className="pb-ir">
          <Search size={18} aria-hidden />
          {total != null ? `Ver ${total.toLocaleString('pt-BR')} ${total === 1 ? 'lote' : 'lotes'}` : 'Buscar'}
        </button>
      </div>
    </form>
  );
}

/** Tipo escolhido que a faceta não trouxe (contagem zero) continua selecionável, senão o select mente. */
function tipos(atual: string, facetas: Facets | null) {
  if (!atual || atual === VARIOS || atual === 'veiculo' || atual === 'imovel') return null;
  if ((facetas?.vehicleTypes ?? []).slice(0, 10).some((r) => r.value === atual)) return null;
  return <option value={atual}>{LABEL_VEHICLE[atual] ?? atual}</option>;
}
