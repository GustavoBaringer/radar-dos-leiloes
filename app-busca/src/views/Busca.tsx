import { useEffect, useMemo, useRef, useState } from 'react';
import { BellPlus, LayoutGrid, Map as MapIcon, SlidersHorizontal } from 'lucide-react';
import type { Facets, Lot, RespostaMapa, SearchResponse } from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { ORDENACOES } from '@/lib/labels';
import { type EstadoBusca, contaFiltros, paramsDaBusca } from '@/lib/filtros';
import { FilterSidebar } from '@/components/FilterSidebar';
import { LotCard } from '@/components/LotCard';
import { MapaLotes } from '@/components/MapaLotes';
import { FolhaMapa } from '@/components/FolhaMapa';

interface Props {
  estado: EstadoBusca;
  aoMudar: (patch: Partial<EstadoBusca>) => void;
  aoLimpar: () => void;
  aoAbrirLote: (id: number) => void;
  aoCriarAlerta: () => void;
  /** Lances chegados pelo WebSocket, por id de lote. */
  lancesAoVivo: Record<number, number>;
  piscando: Set<number>;
  aoCarregar?: (r: SearchResponse) => void;
  favoritos: Set<number>;
  aoFavoritar: (id: number) => void;
}

export function Busca({
  estado, aoMudar, aoLimpar, aoAbrirLote, aoCriarAlerta, lancesAoVivo, piscando, aoCarregar,
  favoritos, aoFavoritar,
}: Props) {
  const [dados, setDados] = useState<SearchResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [gavetaFiltros, setGavetaFiltros] = useState(false);
  const [rotulosServidor, setRotulos] = useState<Record<string, Record<string, string>>>({});
  const [mapa, setMapa] = useState<RespostaMapa | null>(null);
  const [ehCelular, setEhCelular] = useState(false);
  const [mapaCarregando, setMapaCarregando] = useState(false);
  const seq = useRef(0);
  const seqMapa = useRef(0);
  // O texto espera 1s; filtro, ordenação e página continuam imediatos. Sem isto
  // cada tecla virava uma requisição — "onix" disparava quatro buscas.
  const [qAdiado, setQAdiado] = useState(estado.q);
  useEffect(() => {
    if (estado.q === qAdiado) return;
    // Limpar o campo e apertar Buscar (que zera a página) não esperam.
    if (!estado.q || estado.page === 1) {
      const t = setTimeout(() => setQAdiado(estado.q), estado.q ? 1000 : 0);
      return () => clearTimeout(t);
    }
    setQAdiado(estado.q);
  }, [estado.q, estado.page, qAdiado]);
  const qs = useMemo(() => paramsDaBusca({ ...estado, q: qAdiado }), [estado, qAdiado]);

  useEffect(() => {
    const meu = ++seq.current;
    setCarregando(true);
    setErro(null);
    const ac = new AbortController();
    api
      .buscar(qs, ac.signal)
      .then((r) => {
        // Resposta atrasada de uma busca antiga não pode sobrescrever a atual.
        if (meu !== seq.current) return;
        setDados(r);
        setCarregando(false);
        // Cidade manda rótulo próprio (grafia correta) junto da faceta; guardar
        // é o que permite o botão fechado mostrar "Curitiba" e não "CURITIBA".
        setRotulos((antes) => {
          const novo = { ...antes, city: { ...(antes.city ?? {}) } };
          for (const c of r.facets.cities) if (c.label) novo.city[String(c.value)] = c.label;
          return novo;
        });
        aoCarregar?.(r);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || meu !== seq.current) return;
        // Sem isto a tela ficava em esqueleto para sempre, com o contador antigo
        // no lugar, dando a impressão de que havia resultado.
        setCarregando(false);
        setErro(e instanceof ApiError ? `HTTP ${e.status}` : String((e as Error)?.message ?? e));
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);

  // O mapa usa os MESMOS filtros da lista, menos página, ordenação e o ponto
  // escolhido: um ponto selecionado não pode apagar os outros do mapa.
  const qsMapa = useMemo(() => {
    const p = new URLSearchParams(qs);
    p.delete('page'); p.delete('sort'); p.delete('place');
    return p.toString();
  }, [qs]);

  useEffect(() => {
    if (estado.vista !== 'mapa') return;
    const meu = ++seqMapa.current;
    setMapaCarregando(true);
    const ac = new AbortController();
    api
      .mapa(qsMapa, ac.signal)
      .then((r) => { if (meu === seqMapa.current) { setMapa(r); setMapaCarregando(false); } })
      .catch(() => { if (meu === seqMapa.current) setMapaCarregando(false); });
    return () => ac.abort();
  }, [qsMapa, estado.vista]);

  const barraRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!(ehCelular && estado.vista === 'mapa')) return;
    const medir = () => {
      const b = barraRef.current?.getBoundingClientRect().bottom ?? 0;
      document.documentElement.style.setProperty('--topo-mapa', `${Math.max(0, Math.round(b))}px`);
    };
    medir();
    // A barra CRESCE quando chegam os chips de "interpretado como": só resize e
    // scroll deixavam --topo-mapa velho, e o mapa subia por cima dela (medido:
    // barra terminando em 309px com o mapa começando em 246px).
    const obs = new ResizeObserver(medir);
    if (barraRef.current) obs.observe(barraRef.current);
    window.addEventListener('resize', medir);
    window.addEventListener('scroll', medir, { passive: true });
    document.body.style.overflow = 'hidden';
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', medir);
      window.removeEventListener('scroll', medir);
      document.body.style.overflow = '';
    };
  }, [ehCelular, estado.vista]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const ver = () => setEhCelular(mq.matches);
    ver();
    mq.addEventListener('change', ver);
    return () => mq.removeEventListener('change', ver);
  }, []);

  const facetas: Facets | null = dados?.facets ?? null;
  const ehImovel = estado.assetType === 'imovel';
  // O rótulo só afirma o tipo quando o FILTRO garante o tipo. Sem filtro de bem
  // a lista mistura veículo e imóvel, e dizer "veículos" mente.
  const rotuloTotal = ehImovel ? 'imóveis' : estado.assetType === 'veiculo' ? 'veículos' : 'lotes';
  const nFiltros = contaFiltros(estado);
  const paginas = dados ? Math.max(1, Math.ceil(dados.total / dados.pageSize)) : 1;

  const itens: Lot[] = dados?.items ?? [];
  // Esqueleto só na primeira carga: trocar a grade inteira a cada filtro faz a
  // página pular. Com resultado na tela, o sinal é a barra e a opacidade.
  const primeiraCarga = carregando && !dados;

  const grade = (
    <div className={`grade${carregando ? ' carregando' : ''}`}>
      {itens.map((lot) => (
        <LotCard
          key={lot.id}
          lot={lot}
          aoAbrir={aoAbrirLote}
          lanceAoVivo={lancesAoVivo[lot.id]}
          piscando={piscando.has(lot.id)}
          favoritado={favoritos.has(lot.id)}
          aoFavoritar={aoFavoritar}
        />
      ))}
    </div>
  );

  const pontoEscolhido = estado.local
    ? mapa?.pontos.find((p) => estado.local.split(';').includes(p.k))
    : undefined;
  const ehCidade = !!estado.local && !!mapa?.pontos.some((p) => estado.local.split(';').includes(p.k) && p.camada === 'cidade');
  const lotesNoPonto = estado.local
    ? mapa?.pontos.filter((p) => estado.local.split(';').includes(p.k)).reduce((t, p) => t + p.n, 0)
    : undefined;

  const conteudo = erro ? (
    <div className="empty">
      Não foi possível carregar os resultados ({erro}).
      <button className="btn-clear tentar" onClick={() => aoMudar({})}>
        Tentar de novo
      </button>
    </div>
  ) : primeiraCarga ? (
    <div className="grade">
      {Array.from({ length: 8 }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  ) : itens.length === 0 ? (
    <div className="empty">
      Nenhum {ehImovel ? 'imóvel' : estado.assetType === 'veiculo' ? 'veículo' : 'lote'} encontrado
      com esses filtros.
    </div>
  ) : (
    grade
  );

  const cabecalhoDoPonto = estado.local ? (
    <>
      <span>
        Mostrando só os lotes de <b>{pontoEscolhido?.cidade ?? 'um ponto'}</b>
        {lotesNoPonto != null && ` · ${lotesNoPonto.toLocaleString('pt-BR')} lotes`}
        {ehCidade && ' — a fonte publica a cidade, não o endereço'}
      </span>
      <span className="folha-acoes">
        <button type="button" className="btn-pri btn-ver-lotes" onClick={() => aoMudar({ vista: 'grade', page: 1 })}>
          ver os lotes
        </button>
        <button type="button" className="btn-clear" onClick={() => aoMudar({ local: '', page: 1 })}>
          limpar
        </button>
      </span>
    </>
  ) : (
    <span className="folha-resumo">
      <b className="mono">{dados ? dados.total.toLocaleString('pt-BR') : '—'}</b> {rotuloTotal}
      {ehCelular ? ' · toque num ponto' : ' · clique num ponto para filtrar'}
    </span>
  );

  const lateral = (
    <FilterSidebar
      estado={estado}
      facetas={facetas}
      rotulosServidor={rotulosServidor}
      aoMudar={aoMudar}
      aoLimpar={aoLimpar}
      aoFechar={gavetaFiltros ? () => setGavetaFiltros(false) : undefined}
    />
  );

  const interpretado = useMemo(() => {
    const i = dados?.interpreted;
    if (!i) return [];
    const bits: Array<{ k: string; cls: string; txt: string }> = [];
    if (i.brand) bits.push({ k: 'b', cls: 'brand', txt: `marca: ${i.brand}` });
    if (i.model) bits.push({ k: 'm', cls: 'model', txt: `modelo: ${i.model}` });
    for (const t of i.freeTerms) bits.push({ k: `t${t}`, cls: '', txt: `texto: ${t}` });
    return bits;
  }, [dados]);

  return (
    <main className={`faixa layout${estado.vista === 'mapa' ? ' vista-mapa' : ''}`}>
      <button
        type="button"
        className="filtros-toggle"
        aria-expanded={gavetaFiltros}
        onClick={() => setGavetaFiltros((v) => !v)}
      >
        <SlidersHorizontal size={16} aria-hidden />
        <span>Filtros</span>
        {nFiltros > 0 && <span className="ativos mono">{nFiltros}</span>}
      </button>

      {/* Desktop: coluna fixa. Celular: gaveta por baixo, com o mesmo componente. */}
      <div className="lateral-desktop">{lateral}</div>
      {gavetaFiltros && (
        <div className="gaveta-filtros" role="dialog" aria-modal="true" aria-label="Filtros">
          <div className="scrim" onClick={() => setGavetaFiltros(false)} />
          <div className="gaveta-painel">
            {lateral}
            <button type="button" className="btn-pri gaveta-ver" onClick={() => setGavetaFiltros(false)}>
              Ver {dados ? dados.total.toLocaleString('pt-BR') : ''} resultados
            </button>
          </div>
        </div>
      )}

      <section className="resultados">
        {/* A faixa só quebra em duas quando há chips de interpretação: eles têm
            largura imprevisível e esmagavam o seletor. Sem eles, os três
            controles cabem numa linha só e a dobra fica 36px mais curta. */}
        <div className={`resultbar${interpretado.length ? ' tem-interpretacao' : ''}`} ref={barraRef}>
          <div>
            <div className="count">
              <b className="mono">{dados ? dados.total.toLocaleString('pt-BR') : '—'}</b>{' '}
              <span>{rotuloTotal}</span>
            </div>
            {interpretado.length > 0 && (
              <div className="interpreted">
                interpretado como{' '}
                {interpretado.map((b) => (
                  <span key={b.k} className={`pill ${b.cls}`}>
                    {b.txt}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn-alerta"
            onClick={aoCriarAlerta}
            aria-label="Criar alerta para esta busca"
            title="Avisar quando surgir um lote novo para esta busca"
          >
            <BellPlus size={15} aria-hidden />
            <span className="btn-alerta-txt">Criar alerta</span>
          </button>
          <div className="seg-vista" role="group" aria-label="Visualização">
            <button
              type="button"
              aria-pressed={estado.vista === 'grade'}
              onClick={() => aoMudar({ vista: 'grade', page: 1 })}
            >
              <LayoutGrid size={14} aria-hidden />
              <span>Grade</span>
            </button>
            <button
              type="button"
              aria-pressed={estado.vista === 'mapa'}
              onClick={() => aoMudar({ vista: 'mapa', page: 1 })}
            >
              <MapIcon size={14} aria-hidden />
              <span>Mapa</span>
            </button>
          </div>
          <div className="f-group ordena">
            <label htmlFor="sort" className="sr-only">
              Ordenar resultados
            </label>
            <select id="sort" value={estado.sort} onChange={(e) => aoMudar({ sort: e.target.value, page: 1 })}>
              {ORDENACOES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={`barra-carga${carregando ? ' on' : ''}`} aria-hidden>
          <i />
        </div>

        {/* Mapa e grade nunca juntos: são duas formas de ver a MESMA busca, e
            mostrar as duas ao mesmo tempo dobra a rolagem sem dobrar a resposta. */}
        {estado.vista === 'mapa' ? (
          <div className={`mapa-area${ehCelular ? ' mapa-cheio' : ''}`}>
            <MapaLotes
              dados={mapa}
              carregando={mapaCarregando}
              local={estado.local}
              ufAtiva={estado.multi.uf.length === 1 ? estado.multi.uf[0] : undefined}
              aoEscolherLocal={(k) => aoMudar({ local: k, page: 1 })}
            />
            {/* No celular a lista vive SOBRE o mapa, na folha. No desktop o mapa é a
                única vista: a grade some, e a faixa leva de volta a ela. */}
            {ehCelular ? (
              <FolhaMapa
                gatilho={estado.local}
                cabecalho={cabecalhoDoPonto}
                aoVerGrade={() => aoMudar({ vista: 'grade', page: 1 })}
              >
                {conteudo}
              </FolhaMapa>
            ) : (
              <div className="mapa-selecao">{cabecalhoDoPonto}</div>
            )}
          </div>
        ) : (
          conteudo
        )}

        {estado.vista === 'grade' && dados && dados.total > 0 && (
          <div className="pager">
            <button
              disabled={estado.page <= 1}
              onClick={() => {
                aoMudar({ page: estado.page - 1 });
                window.scrollTo(0, 0);
              }}
            >
              Anterior
            </button>
            <span className="pageinfo mono">
              página {dados.page} de {paginas.toLocaleString('pt-BR')}
            </span>
            <button
              disabled={estado.page >= paginas}
              onClick={() => {
                aoMudar({ page: estado.page + 1 });
                window.scrollTo(0, 0);
              }}
            >
              Próxima
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
