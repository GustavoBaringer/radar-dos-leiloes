import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { BellPlus, LayoutGrid, List, Map as MapIcon, SlidersHorizontal } from 'lucide-react';
import type { Facets, Lot, RespostaMapa, SearchResponse } from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { ORDENACOES } from '@/lib/labels';
import { type EstadoBusca, contaFiltros, paramsDaBusca } from '@/lib/filtros';
import { FilterSidebar } from '@/components/FilterSidebar';
import { LotCard } from '@/components/LotCard';
import { MapaLotes } from '@/components/MapaLotes';
import { FolhaMapa } from '@/components/FolhaMapa';
import { PainelBusca } from '@/components/PainelBusca';
import { FiltrosAtivos, filtrosAtivos } from '@/components/FiltrosAtivos';
import { VistosRecentes } from '@/components/VistosRecentes';
import { ComoFunciona } from '@/components/ComoFunciona';

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

/** Depois de quantos cartões entra a faixa de alerta: cedo o bastante para ser vista, tarde para não tapar o resultado. */
const POS_FAIXA = 6;

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
  const resultadosRef = useRef<HTMLElement>(null);
  // O texto espera 1s; filtro, ordenação e página continuam imediatos. Sem isto
  // cada tecla virava uma requisição — "onix" disparava quatro buscas.
  const [qAdiado, setQAdiado] = useState(estado.q);
  useEffect(() => {
    if (estado.q === qAdiado) return;
    // A página só volta para 1 junto com o termo: zerar na tecla muda a chave da
    // busca e dispara uma requisição com o termo antigo.
    const t = setTimeout(() => {
      setQAdiado(estado.q);
      if (estado.page !== 1) aoMudar({ page: 1 });
    }, estado.q ? 1000 : 0);
    return () => clearTimeout(t);
  }, [estado.q, estado.page, qAdiado, aoMudar]);
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
    // scroll deixavam --topo-mapa velho, e o mapa subia por cima dela.
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
  const ativos = filtrosAtivos({ ...estado, q: qAdiado }, rotulosServidor);
  const resumo = ativos.map((a) => a.texto).join(' · ');
  const ehMapa = estado.vista === 'mapa';

  const itens: Lot[] = dados?.items ?? [];
  // Esqueleto só na primeira carga: trocar a grade inteira a cada filtro faz a
  // página pular. Com resultado na tela, o sinal é a barra e a opacidade.
  const primeiraCarga = carregando && !dados;

  function rolarParaResultados() {
    resultadosRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function enviar() {
    setQAdiado(estado.q);
    if (estado.page !== 1) aoMudar({ page: 1 });
    (document.activeElement as HTMLElement | null)?.blur();
    rolarParaResultados();
  }

  const faixaAlerta = (
    <div className="faixa-alerta" key="faixa-alerta">
      <div className="fa-txt">
        <span className="fa-ico"><BellPlus aria-hidden /></span>
        <div>
          <h3>{resumo ? 'Avise-me quando entrar lote novo' : 'Não perca o próximo lote'}</h3>
          <p>{resumo || 'Filtre por modelo, tipo ou região e salve a busca como alerta.'}</p>
        </div>
      </div>
      {resumo ? (
        <button type="button" className="btn-cta" onClick={aoCriarAlerta}>Criar alerta para esta busca</button>
      ) : (
        <button type="button" className="btn-fantasma" onClick={() => document.getElementById('q')?.focus()}>Começar uma busca</button>
      )}
    </div>
  );

  const grade = (
    <div className={`grade${estado.vista === 'lista' ? ' lista' : ''}${carregando ? ' carregando' : ''}`}>
      {itens.map((lot, i) => (
        <Fragment key={lot.id}>
          {i === Math.min(POS_FAIXA, itens.length) && !ehMapa && faixaAlerta}
          <LotCard
            lot={lot}
            aoAbrir={aoAbrirLote}
            lanceAoVivo={lancesAoVivo[lot.id]}
            piscando={piscando.has(lot.id)}
            favoritado={favoritos.has(lot.id)}
            aoFavoritar={aoFavoritar}
          />
        </Fragment>
      ))}
      {itens.length > 0 && itens.length <= POS_FAIXA && !ehMapa && faixaAlerta}
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
      {Array.from({ length: 6 }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  ) : itens.length === 0 ? (
    <div className="empty vazio-rico">
      <h3>Nenhum {ehImovel ? 'imóvel' : estado.assetType === 'veiculo' ? 'veículo' : 'lote'} com esses filtros</h3>
      <p>{resumo ? 'Crie um alerta e o Radar avisa quando entrar um lote que combine.' : 'Tente outro termo de busca.'}</p>
      <div className="vazio-acoes">
        {resumo && <button type="button" className="btn-cta" onClick={aoCriarAlerta}>Criar alerta para esta busca</button>}
        {nFiltros > 0 && <button type="button" className="btn-fantasma" onClick={aoLimpar}>Limpar filtros</button>}
      </div>
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

  const vistas: Array<[EstadoBusca['vista'], string, typeof LayoutGrid]> = [
    ['grade', 'Grade', LayoutGrid], ['lista', 'Lista', List], ['mapa', 'Mapa', MapIcon],
  ];

  return (
    <>
      <div className="faixa pb-wrap">
        <PainelBusca
          estado={estado}
          facetas={facetas}
          total={dados?.total ?? null}
          esperando={!!estado.q && estado.q !== qAdiado}
          aoMudar={aoMudar}
          aoEnviar={enviar}
        />
      </div>

      <main ref={resultadosRef} id="resultados" className={`faixa layout${ehMapa ? ' vista-mapa' : ''}`}>
        {/* Desktop: coluna fixa. Celular: gaveta por baixo, com o mesmo componente. */}
        <div className="lateral-desktop">{lateral}</div>
        {gavetaFiltros && (
          <div className="gaveta-filtros" role="dialog" aria-modal="true" aria-label="Filtros">
            <div className="scrim" onClick={() => setGavetaFiltros(false)} />
            <div className="gaveta-painel">
              {lateral}
              <button type="button" className="btn-cta gaveta-ver" onClick={() => setGavetaFiltros(false)}>
                Ver {dados ? dados.total.toLocaleString('pt-BR') : ''} {rotuloTotal}
              </button>
            </div>
          </div>
        )}

        <section className="resultados">
          <div className="resultbar" ref={barraRef}>
            <div className="rb-titulo">
              <h2 className="count">
                <b className="mono">{dados ? dados.total.toLocaleString('pt-BR') : '—'}</b> {rotuloTotal}
              </h2>
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
            <div className="rb-ctl">
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
              <button
                type="button"
                className="btn-alerta"
                onClick={aoCriarAlerta}
                aria-label="Salvar esta busca como alerta"
                title="Avisar quando surgir um lote novo para esta busca"
              >
                <BellPlus size={16} aria-hidden />
                <span className="btn-alerta-txt">Salvar busca</span>
              </button>
              <div className="ordena">
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
              <div className="seg-vista" role="group" aria-label="Visualização">
                {vistas.map(([v, nome, Ico]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={estado.vista === v}
                    aria-label={nome}
                    title={nome}
                    onClick={() => aoMudar({ vista: v, page: 1 })}
                  >
                    <Ico size={16} aria-hidden />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <FiltrosAtivos ativos={ativos} estado={estado} aoMudar={aoMudar} aoLimpar={aoLimpar} />

          <div className={`barra-carga${carregando ? ' on' : ''}`} aria-hidden>
            <i />
          </div>

          {/* Mapa e grade nunca juntos: são duas formas de ver a MESMA busca, e
              mostrar as duas ao mesmo tempo dobra a rolagem sem dobrar a resposta. */}
          {ehMapa ? (
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

          {!ehMapa && dados && dados.total > 0 && (
            <div className="pager">
              <button
                disabled={estado.page <= 1}
                onClick={() => {
                  aoMudar({ page: estado.page - 1 });
                  rolarParaResultados();
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
                  rolarParaResultados();
                }}
              >
                Próxima
              </button>
            </div>
          )}
        </section>
      </main>

      {!ehMapa && <VistosRecentes aoAbrir={aoAbrirLote} />}
      {!ehMapa && <ComoFunciona />}
    </>
  );
}
