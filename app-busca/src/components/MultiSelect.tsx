import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { FacetRow } from '@/lib/types';
import { type DefMulti, resumoMulti, rotuloOpcao } from '@/lib/filtros';

/**
 * Faceta de seleção múltipla.
 *
 * Não é `<select multiple>` de propósito: o nativo exige segurar Ctrl no
 * desktop e vira lista rolante no toque.
 *
 * Duas regras de montagem da lista que parecem detalhe e não são:
 *
 * 1. Taxonomia FIXA mostra opção com zero — o usuário precisa ver que "Imóvel"
 *    existe e está vazia, senão a opção nem aparece e escolhê-la falha calado.
 *    Faceta livre (UF, fonte, leiloeiro) só mostra o que existe.
 * 2. O que já está MARCADO aparece sempre, mesmo com contagem zero. Sem isso o
 *    filtro ativo some da lista e não há como desfazê-lo.
 */

/** Acima disto a lista ganha campo de busca: leiloeiro traz 80 e cidade, 300. */
const LIMIAR_BUSCA = 12;

interface Props {
  def: DefMulti;
  linhas: FacetRow[];
  escolhidos: string[];
  rotulosServidor: Record<string, string>;
  aoMudar: (valores: string[]) => void;
}

export function MultiSelect({ def, linhas, escolhidos, rotulosServidor, aoMudar }: Props) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const caixa = useRef<HTMLDivElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  const rotuloId = useId();
  const resumoId = useId();

  // Clique fora fecha; Esc fecha e devolve o foco ao botão, senão quem navega
  // por teclado fica preso dentro de uma lista invisível.
  useEffect(() => {
    if (!aberto) return;
    const clique = (e: MouseEvent) => {
      if (!caixa.current?.contains(e.target as Node)) setAberto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAberto(false);
        botao.current?.focus();
      }
    };
    document.addEventListener('mousedown', clique);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', clique);
      document.removeEventListener('keydown', tecla);
    };
  }, [aberto]);

  const marcados = useMemo(() => new Set(escolhidos), [escolhidos]);

  const opcoes = useMemo(() => {
    const contas = new Map(linhas.map((r) => [String(r.value), r.count]));
    const rotulos = new Map(linhas.map((r) => [String(r.value), rotuloOpcao(def, r)]));
    const valores = def.fixas
      ? Object.keys(def.fixas)
      : [...new Set([...linhas.map((r) => String(r.value)), ...escolhidos])];
    return valores
      .map((v) => ({
        v,
        l: rotulos.get(v) ?? rotulosServidor[v] ?? def.fixas?.[v] ?? def.rotulo?.(v) ?? v,
        n: contas.get(v) ?? 0,
      }))
      .filter((o) => def.fixas || o.n > 0 || marcados.has(o.v))
      .sort((a, b) => b.n - a.n || a.l.localeCompare(b.l, 'pt-BR'));
  }, [def, linhas, escolhidos, rotulosServidor, marcados]);

  const filtradas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    if (!t) return opcoes;
    return opcoes.filter((o) => o.l.toLowerCase().includes(t));
  }, [opcoes, busca]);

  const resumo = resumoMulti(def, escolhidos, rotulosServidor);
  const temBusca = opcoes.length > LIMIAR_BUSCA;

  function alternar(v: string) {
    aoMudar(marcados.has(v) ? escolhidos.filter((x) => x !== v) : [...escolhidos, v]);
  }

  return (
    <div className="f-group">
      <label id={rotuloId} className="f-label">
        {def.titulo}
      </label>
      <div className="multi" ref={caixa}>
        <button
          type="button"
          ref={botao}
          className={`multi-botao${escolhidos.length ? ' tem-selecao' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={aberto}
          aria-labelledby={`${rotuloId} ${resumoId}`}
          onClick={() => {
            setAberto((v) => !v);
            setBusca('');
          }}
        >
          <span id={resumoId} className="multi-resumo">
            {resumo}
          </span>
          <ChevronDown size={15} aria-hidden className={`chev${aberto ? ' aberto' : ''}`} />
        </button>

        {aberto && (
          <div className="multi-lista" role="listbox" aria-multiselectable aria-labelledby={rotuloId}>
            {temBusca && (
              <div className="multi-busca">
                <Search size={14} aria-hidden />
                <input
                  autoFocus
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder={`Filtrar ${def.titulo.toLowerCase()}…`}
                  aria-label={`Filtrar opções de ${def.titulo}`}
                />
              </div>
            )}
            <div className="multi-rolagem">
              {filtradas.length ? (
                filtradas.map((o) => (
                  <label key={o.v}>
                    <input
                      type="checkbox"
                      checked={marcados.has(o.v)}
                      onChange={() => alternar(o.v)}
                    />
                    <span>{o.l}</span>
                    <span className="conta mono">{o.n.toLocaleString('pt-BR')}</span>
                  </label>
                ))
              ) : (
                <p className="multi-vazio">
                  {busca ? 'Nada com esse texto.' : 'Nenhuma opção para os filtros atuais.'}
                </p>
              )}
            </div>
            <div className="multi-acoes">
              <button type="button" onClick={() => aoMudar([])} disabled={!escolhidos.length}>
                Limpar seleção
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
