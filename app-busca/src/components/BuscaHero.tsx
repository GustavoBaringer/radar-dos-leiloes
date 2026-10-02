import { ArrowRight, Check } from 'lucide-react';
import type { Lot } from '@/lib/types';
import { SRC_LABEL } from '@/lib/labels';
import { fracaoDaAvaliacao, img, money, rotuloLance, titulo } from '@/lib/format';

interface Props {
  /** Tamanho do índice sem filtro; nulo enquanto a primeira busca sem filtro não volta. */
  totalIndice: number | null;
  nFontes: number | null;
  destaques: Lot[];
  aoAbrir: (id: number) => void;
  aoVerLotes: () => void;
  aoCriarAlerta: () => void;
}

const POSICOES = ['a', 'b', 'c'];

export function BuscaHero({ totalIndice, nFontes, destaques, aoAbrir, aoVerLotes, aoCriarAlerta }: Props) {
  return (
    <section className="hero">
      <div className="faixa hero-grade">
        <div className="hero-texto">
          {totalIndice != null && (
            <span className="hero-selo">
              <i aria-hidden />
              {totalIndice.toLocaleString('pt-BR')} lotes ativos{nFontes ? ` de ${nFontes} fontes` : ''}
            </span>
          )}
          <h1>
            Leilões de veículos e imóveis, <em>numa só busca</em>
          </h1>
          <p className="hero-lead">
            Compare lance, prazo e avaliação de várias plataformas de leilão. Salve a busca como alerta e
            saiba do próximo lote antes de abrir site por site.
          </p>
          <div className="hero-cta">
            <button type="button" className="btn-cta" onClick={aoVerLotes}>
              Ver os lotes <ArrowRight size={17} aria-hidden />
            </button>
            <button type="button" className="btn-fantasma" onClick={aoCriarAlerta}>
              Criar alerta
            </button>
          </div>
          <ul className="hero-confianca">
            <li><Check size={15} aria-hidden /> Preço com o rótulo certo</li>
            <li><Check size={15} aria-hidden /> Placas mascaradas</li>
            <li><Check size={15} aria-hidden /> Link direto para a fonte</li>
          </ul>
        </div>

        {/* Decorativo para leitor de tela: os mesmos lotes estão na grade logo abaixo. */}
        <div className="hero-pilha" aria-hidden>
          {destaques.slice(0, 3).map((l, i) => {
            const lance = l.current_bid ?? l.min_bid;
            const fracao = fracaoDaAvaliacao(l, lance);
            const local = l.city ? ` · ${l.city}/${l.state}` : '';
            return (
              <button type="button" tabIndex={-1} key={l.id} className={`hero-card ${POSICOES[i]}`} onClick={() => aoAbrir(l.id)}>
                <img src={img(l.photos[0], 480)} alt="" />
                <span className="hero-card-txt">
                  <b>{titulo(l)}</b>
                  {lance != null && <span className="mono">{money(lance)}</span>}
                  <small>
                    {fracao != null ? `${rotuloLance(l)} · ${fracao}% da avaliação` : `${SRC_LABEL[l.source_id] ?? l.source_id}${local}`}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
