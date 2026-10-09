import { useCallback, useEffect, useRef, useState } from 'react';
import type { Alerta, Lot, WsMessage } from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { applyAccountSummary, beginFavoriteMutation, emptyFavoriteContext, mergeFavoriteResponse, settleFavoriteMutation, summaryIsCurrent, type FavoriteReadStamp } from '@/lib/favorite-context';
import { type EstadoBusca, ESTADO_VAZIO, estadoDaUrl, urlDoEstado, urlDoAlerta, CAMPOS_FILTRO, MULTI_IDS } from '@/lib/filtros';
import { money } from '@/lib/format';
import { registrarVisto } from '@/lib/vistos';
import { idDoSlug, slugDoLote } from '@/lib/slug';
import { AppHeader, type Aba } from '@/components/AppHeader';
import { Rodape } from '@/components/Rodape';
import { LotDrawer } from '@/components/LotDrawer';
import { Toasts } from '@/components/Toasts';
import { DialogoAlerta, type AlvoDialogo } from '@/components/DialogoAlerta';
import { Busca } from '@/views/Busca';
import { Alertas } from '@/views/Alertas';
import { Favoritos } from '@/views/Favoritos';
import { Cobertura } from '@/views/Cobertura';
import { useToasts } from '@/hooks/useToasts';
import { useWebSocket } from '@/hooks/useWebSocket';

function abaDoCaminho(p: string): Aba {
  if (p === '/alertas') return 'alertas';
  if (p === '/favoritos') return 'favoritos';
  if (p === '/cobertura') return 'cobertura';
  return 'busca';
}

/**
 * `loteInicial` chega do SSR de /lote/:slug.
 *
 * O servidor renderiza a gaveta JÁ com o lote dentro, para o robô de busca ler
 * o conteúdo no HTML; o cliente recebe o mesmo objeto por `window.__LOTE__` e
 * hidrata sobre a mesma árvore. Passar o dado nos dois lados é o que evita o
 * mismatch — renderizar coisas diferentes no servidor e no cliente faz o React
 * descartar o HTML que o crawler acabou de ler.
 */
export default function App({ loteInicial = null, publico = false }: { loteInicial?: Lot | null; publico?: boolean }) {
  const [estado, setEstado] = useState<EstadoBusca>(() =>
    typeof window === 'undefined' ? ESTADO_VAZIO : estadoDaUrl(window.location.search),
  );
  const [aba, setAba] = useState<Aba>(() =>
    typeof window === 'undefined' ? 'busca' : abaDoCaminho(window.location.pathname),
  );
  const [lote, setLote] = useState<Lot | null>(loteInicial);
  const [papel, setPapel] = useState<string>('comum');
  const [naoVistos, setNaoVistos] = useState<number | null>(null);
  const [versaoAlertas, setVersaoAlertas] = useState(0);
  const [favoriteContext, setFavoriteContext] = useState(() => loteInicial?.favorited == null
    ? emptyFavoriteContext()
    : mergeFavoriteResponse(emptyFavoriteContext(), [loteInicial]));
  const favoriteContextRef = useRef(favoriteContext);
  const favoriteToken = useRef(0);
  const accountKey = useRef<string | null>(null);
  const ownerEpoch = useRef(0);
  const summaryGeneration = useRef({ request: 0, identity: 0, mutation: 0 });
  const [versaoFavoritos, setVersaoFavoritos] = useState(0);
  const [alvoDialogo, setAlvoDialogo] = useState<AlvoDialogo | null>(null);
  const [lancesAoVivo, setLances] = useState<Record<number, number>>({});
  const [piscando, setPiscando] = useState<Set<number>>(new Set());
  const { toasts, toast } = useToasts();
  // O foco volta para o cartão de origem: sem isto, quem navega por teclado era
  // devolvido ao topo da página a cada lote aberto.
  const focoAnterior = useRef<HTMLElement | null>(null);

  const aceitarResumo = useCallback((r: Awaited<ReturnType<typeof api.eu>>, started: typeof summaryGeneration.current) => {
    const responseIdentity = r.logado === false ? 'anon' : r.conta?.id == null ? null : String(r.conta.id);
    const trocaDeConta = responseIdentity !== null && accountKey.current !== null && responseIdentity !== accountKey.current;
    if (!summaryIsCurrent(started, summaryGeneration.current, trocaDeConta ? 0 : favoriteContextRef.current.pending.size)) return;
    const result = applyAccountSummary(favoriteContextRef.current, r, accountKey.current);
    if (!result.accepted) return;
    if (result.changed) {
      ownerEpoch.current += 1;
      summaryGeneration.current.identity += 1;
      favoriteToken.current += 1;
      setNaoVistos(null);
    }
    accountKey.current = result.identity;
    favoriteContextRef.current = result.state;
    setFavoriteContext(result.state);
    setNaoVistos(result.unreadAlertCount);
    setPapel(r.papel ?? 'comum');
  }, []);

  const atualizarResumo = useCallback(() => {
    const started = { ...summaryGeneration.current, request: summaryGeneration.current.request + 1 };
    summaryGeneration.current = started;
    void api.eu().then((r) => aceitarResumo(r, started)).catch(() => {});
  }, [aceitarResumo]);

  /* ---------------- papel e resumo global da conta ---------------- */
  useEffect(() => {
    if (publico) return; // sem sessão, /api/me devolve 401
    atualizarResumo();
  }, [publico, atualizarResumo]);

  const iniciarLeituraFavoritos = useCallback((): FavoriteReadStamp => ({ ownerEpoch: ownerEpoch.current, owner: accountKey.current, revisions: new Map(favoriteContextRef.current.revisions) }), []);
  const conhecerLotes = useCallback((lotes: Lot[], stamp?: FavoriteReadStamp) => {
    const next = mergeFavoriteResponse(favoriteContextRef.current, lotes, stamp, ownerEpoch.current, accountKey.current);
    favoriteContextRef.current = next;
    setFavoriteContext(next);
  }, []);
  const favoritos = new Set([...favoriteContext.known].filter(([, value]) => value).map(([id]) => id));
  const aoContarNaoVistos = useCallback((n: number) => {
    setNaoVistos(n);
    if (n === 0) atualizarResumo();
  }, [atualizarResumo]);

  /**
   * Otimista: a estrela muda na hora, e desfaz sozinha se o servidor recusar.
   * Sem isto, cada clique esperaria a viagem de rede para acender — no card
   * dentro de uma lista rolando, essa espera lê como "não funcionou".
   */
  const alternarFavorito = useCallback((id: number) => {
    const current = favoriteContextRef.current;
    if (current.pending.has(id)) return;
    const jaEra = current.known.get(id) === true;
    const token = ++favoriteToken.current;
    summaryGeneration.current.mutation += 1;
    const otimista = beginFavoriteMutation(current, id, !jaEra, token);
    favoriteContextRef.current = otimista;
    setFavoriteContext(otimista);
    setVersaoFavoritos((v) => v + 1);
    const ownerAtStart = accountKey.current;
    (jaEra ? api.desfavoritar(id) : api.favoritar(id)).then(() => {
      if (ownerAtStart !== accountKey.current) return;
      const next = settleFavoriteMutation(favoriteContextRef.current, id, token, true);
      summaryGeneration.current.mutation += 1;
      favoriteContextRef.current = next;
      setFavoriteContext(next);
      setVersaoFavoritos((v) => v + 1);
      atualizarResumo();
    }).catch(() => {
      if (ownerAtStart !== accountKey.current) return;
      const next = settleFavoriteMutation(favoriteContextRef.current, id, token, false);
      summaryGeneration.current.mutation += 1;
      favoriteContextRef.current = next;
      setFavoriteContext(next);
      setVersaoFavoritos((v) => v + 1);
      toast('Não foi possível salvar o favorito. Tente de novo.');
      atualizarResumo();
    });
  }, [toast, atualizarResumo]);

  /* ---------------- rotas ---------------- */

  const abrirLote = useCallback(async (id: number, empilhar = true, slugEsperado?: string) => {
    const leituraFavorito = iniciarLeituraFavoritos();
    focoAnterior.current = document.activeElement as HTMLElement;
    // API lenta: sem retorno, o clique no card parecia ignorado.
    const lento = window.setTimeout(() => toast('Abrindo lote…'), 600);
    try {
      const l = await api.lote(id);
      if (slugEsperado !== undefined && slugDoLote(l) !== slugEsperado) {
        setLote(null);
        toast('Lote não encontrado.');
        return;
      }
      setLote(l);
      conhecerLotes([l], leituraFavorito);
      registrarVisto(l);
      // A URL do lote é compartilhável: quem recebe o link abre a gaveta direto.
      if (empilhar) history.pushState({ lote: l.id }, '', `/lote/${slugDoLote(l)}`);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? 'Lote não encontrado.' : 'Não foi possível abrir o lote agora. Tente de novo.');
    } finally {
      window.clearTimeout(lento);
    }
  }, [toast, conhecerLotes, iniciarLeituraFavoritos]);

  const fecharGaveta = useCallback((voltarHistorico = true) => {
    setLote((atual) => {
      // Fechar pelo X ou Esc tem de desfazer o pushState, senão o "voltar" do
      // navegador reabriria a gaveta que o usuário acabou de fechar.
      if (atual && voltarHistorico && location.pathname.startsWith('/lote/')) history.back();
      return null;
    });
    if (focoAnterior.current && document.contains(focoAnterior.current)) focoAnterior.current.focus();
  }, []);

  // Abertura direta em /lote/:slug (link compartilhado ou recarga).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Com SSR o lote já veio no HTML: refazer o fetch aqui seria uma requisição
    // a mais para pintar exatamente a mesma tela.
    if (!loteInicial && location.pathname.startsWith('/lote/')) {
      const slug = location.pathname.slice(6);
      const id = idDoSlug(slug);
      if (id) void abrirLote(id, false, slug);
      else {
        setLote(null);
        toast('Lote não encontrado.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * replaceState e não pushState: cada troca de filtro empilharia uma entrada e
   * o "voltar" viraria um desfazer clique a clique. Quem empilha é a troca de
   * aba, a abertura do lote e a troca de PÁGINA — esta é navegação, e o voltar
   * saía da busca inteira em vez de voltar para a página anterior.
   */
  useEffect(() => {
    if (aba !== 'busca' || location.pathname.startsWith('/lote/')) return;
    const alvo = urlDoEstado(estado);
    if (location.pathname + location.search === alvo) return;
    const trocouPagina = location.pathname === '/busca' && estadoDaUrl(location.search).page !== estado.page;
    if (trocouPagina) history.pushState(history.state, '', alvo);
    else history.replaceState(history.state, '', alvo);
  }, [estado, aba]);

  const trocarAba = useCallback((a: Aba) => {
    setAba(a);
    setLote(null);
    const alvo = a === 'busca' ? urlDoEstado(estado) : `/${a}`;
    if (location.pathname + location.search !== alvo) history.pushState({ aba: a }, '', alvo);
  }, [estado]);

  useEffect(() => {
    function aoVoltar() {
      const p = location.pathname;
      if (p.startsWith('/lote/')) {
        const slug = p.slice(6);
        const id = idDoSlug(slug);
        if (id) void abrirLote(id, false, slug);
        else {
          setLote(null);
          toast('Lote não encontrado.');
        }
        return;
      }
      setLote(null);
      setAba(abaDoCaminho(p));
      // Voltar para uma URL de busca diferente tem de repintar os filtros.
      setEstado(estadoDaUrl(location.search));
    }
    window.addEventListener('popstate', aoVoltar);
    return () => window.removeEventListener('popstate', aoVoltar);
  }, [abrirLote, toast]);

  /* ---------------- ao vivo ---------------- */

  const aoReceber = useCallback((msg: WsMessage) => {
    if (msg.type === 'bids') {
      setLances((antes) => {
        const novo = { ...antes };
        for (const c of msg.changes) novo[c.lotId] = c.newBid;
        return novo;
      });
      setPiscando(new Set(msg.changes.map((c) => c.lotId)));
      setTimeout(() => setPiscando(new Set()), 1200);
      for (const c of msg.changes) toast(`Novo lance: ${c.title.slice(0, 40)} → ${money(c.newBid)}`);
    }
    // O servidor já não envia 'collect' para quem não é admin; esta guarda é o
    // segundo cinto, para o caso de a mensagem chegar por outro caminho.
    if (msg.type === 'collect' && papel === 'admin') {
      toast(`Coleta ${msg.sourceId}: ${msg.upserted} lotes atualizados`);
    }
    if (msg.type === 'encerrados' && papel === 'admin') {
      const n = Number(msg.total) || 0;
      toast(`${n.toLocaleString('pt-BR')} lote${n === 1 ? '' : 's'} encerrado${n === 1 ? '' : 's'}`);
    }
    if (msg.type === 'alertas') {
      setNaoVistos((n) => n == null ? n : n + msg.disparos.length);
      if (naoVistos == null) atualizarResumo();
      const grupos = new Map<number, { label: string; lotes: Set<number> }>();
      for (const d of msg.disparos) {
        const grupo = grupos.get(d.alertId) ?? { label: d.label, lotes: new Set<number>() };
        grupo.lotes.add(d.lotId);
        grupos.set(d.alertId, grupo);
      }
      for (const grupo of grupos.values()) {
        const n = grupo.lotes.size;
        toast(`Radar: Encontramos ${n} ${n === 1 ? 'novo lote' : 'novos lotes'} para o seu alerta "${grupo.label}"`);
      }
      if (aba === 'alertas') setVersaoAlertas((v) => v + 1);
    }
  }, [papel, aba, toast, naoVistos, atualizarResumo]);

  // O /ws também exige sessão: conectar sem ela é 401 em laço de reconexão.
  const aoVivo = useWebSocket(publico ? null : aoReceber);

  /* ---------------- filtros ---------------- */

  const mudar = useCallback((patch: Partial<EstadoBusca>) => {
    setEstado((e) => ({ ...e, ...patch, multi: patch.multi ?? e.multi }));
  }, []);

  // Vista e ordenação são jeito de VER, não filtro: "Limpar tudo" no mapa voltava para a grade.
  const limpar = useCallback(() => setEstado((e) => ({ ...ESTADO_VAZIO, multi: { ...ESTADO_VAZIO.multi }, vista: e.vista, sort: e.sort })), []);

  /** Alerta vira busca: mesma tela, filtros do alerta já pintados. */
  const aplicarAlerta = useCallback((a: Alerta) => {
    const alvo = urlDoAlerta(a);
    setLote(null);
    setEstado(estadoDaUrl(alvo.slice(alvo.indexOf('?') + 1)));
    setAba('busca');
    if (location.pathname + location.search !== alvo) history.pushState({ aba: 'busca' }, '', alvo);
  }, []);

  /** O alerta guarda a busca da tela: termo + filtros ativos. */
  const abrirDialogoCriar = useCallback(() => {
    const filtros: Record<string, string | boolean> = {};
    for (const id of CAMPOS_FILTRO) if (estado[id]) filtros[id] = estado[id];
    for (const id of MULTI_IDS) if (estado.multi[id].length) filtros[id] = estado.multi[id].join(',');
    if (estado.onlyWithPhoto) filtros.onlyWithPhoto = true;
    if (estado.abaixo) filtros.belowAppraisal = true;
    // O casamento do alerta (core/alerts.ts) não conhece prazo, "com data" nem ponto
    // do mapa: contá-los no resumo prometia um filtro que o alerta não guarda.
    const foraDoAlerta = [
      estado.prazo && 'encerramento',
      estado.onlyWithDate && 'com data',
      estado.local && 'ponto do mapa',
    ].filter(Boolean) as string[];
    const q = estado.q.trim();
    if (!q && !Object.keys(filtros).length) {
      toast(
        foraDoAlerta.length
          ? `O alerta não usa ${foraDoAlerta.join(', ')}. Escolha um termo, tipo, região ou preço.`
          : 'Faça uma busca ou escolha um filtro antes de criar o alerta.',
      );
      return;
    }
    const salvos = Object.keys(filtros).length;
    setAlvoDialogo({
      alerta: null,
      label: q || 'Meus filtros',
      q,
      filtros,
      resumo: [
        q ? `busca "${q}"` : null,
        salvos ? `${salvos} filtro(s)` : null,
        foraDoAlerta.length ? `sem ${foraDoAlerta.join(', ')} (não vale para alerta)` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }, [estado, toast]);

  const abrirDialogoEditar = useCallback((a: Alerta) => {
    setAlvoDialogo({
      alerta: a, label: a.label, q: a.q ?? '', filtros: {},
      resumo: a.q ? `busca "${a.q}"` : 'somente filtros',
    });
  }, []);

  /**
   * Página pública do lote: é o que o link compartilhado abre e o que o robô do
   * WhatsApp lê. Mostra o bem, o prazo e o caminho para o leiloeiro — que é o
   * que a fonte já publica — e convida a entrar para o resto. A busca, as
   * facetas e os alertas ficam atrás da conta.
   */
  if (publico) {
    // Derivado do próprio lote, não de `window.location`: o servidor não tem
    // location, e um valor diferente dos dois lados quebraria a hidratação.
    const voltarPara = lote ? `/lote/${slugDoLote(lote)}` : undefined;
    return (
      <>
        <AppHeader
          publico
          voltarPara={voltarPara}
          aba="busca" aoTrocarAba={() => {}}
          aoVivo={false} naoVistos={0} mostraCobertura={false}
        />
        <LotDrawer lot={lote} aoFechar={() => {}} comoPagina />
        <section className="faixa convite">
          <div>
            {/* Sem número fixo: "21 mil" e "12 plataformas" envelheciam a cada coleta. */}
            <h2>Este é só um dos lotes no índice</h2>
            <p>
              Veículos e imóveis de leilões oficiais de todo o Brasil, com busca por modelo, filtro por
              estado, cidade, comitente e leiloeiro, e alerta quando entrar um lote como este.
            </p>
          </div>
          {/* Este vai para a busca de propósito: o texto promete buscar. Quem
              quer voltar ao anúncio usa o "Entrar" do topo. */}
          <a className="btn-cta" href="/login?de=%2Fbusca">Entrar e buscar</a>
        </section>
        <Rodape />
      </>
    );
  }

  return (
    <>
      <AppHeader
        aba={aba}
        aoTrocarAba={trocarAba}
        aoVivo={aoVivo}
        naoVistos={naoVistos}
        nFavoritos={favoriteContext.count ?? undefined}
        aoCriarAlerta={abrirDialogoCriar}
        mostraCobertura={papel === 'admin'}
      />

      {aba === 'busca' && (
        <Busca
          key={`busca-${ownerEpoch.current}`}
          estado={estado}
          aoMudar={mudar}
          aoLimpar={limpar}
          aoAbrirLote={abrirLote}
          aoCriarAlerta={abrirDialogoCriar}
          lancesAoVivo={lancesAoVivo}
          piscando={piscando}
          favoritos={favoritos}
          aoFavoritar={alternarFavorito}
          aoConhecerLotes={conhecerLotes}
          iniciarLeituraFavoritos={iniciarLeituraFavoritos}
        />
      )}
      {aba === 'alertas' && (
        <Alertas
          key={`alertas-${ownerEpoch.current}`}
          aoAbrirLote={abrirLote}
          toast={toast}
          aoEditar={abrirDialogoEditar}
          aoAplicar={aplicarAlerta}
          versao={versaoAlertas}
          aoContarNaoVistos={aoContarNaoVistos}
          favoritos={favoritos}
          aoFavoritar={alternarFavorito}
          aoConhecerLotes={conhecerLotes}
          iniciarLeituraFavoritos={iniciarLeituraFavoritos}
        />
      )}
      {aba === 'favoritos' && (
        <Favoritos
          key={`favoritos-${ownerEpoch.current}`}
          aoAbrirLote={abrirLote}
          toast={toast}
          versao={versaoFavoritos}
          aoDesfavoritar={alternarFavorito}
          aoConhecerLotes={conhecerLotes}
          iniciarLeituraFavoritos={iniciarLeituraFavoritos}
        />
      )}
      {aba === 'cobertura' && papel === 'admin' && <Cobertura />}

      <Rodape />
      <LotDrawer
        lot={lote}
        aoFechar={() => fecharGaveta()}
        favoritado={lote ? (favoriteContext.known.get(lote.id) ?? lote.favorited) : undefined}
        aoFavoritar={alternarFavorito}
      />
      <DialogoAlerta
        alvo={alvoDialogo}
        aoFechar={() => setAlvoDialogo(null)}
        aoSalvar={() => setVersaoAlertas((v) => v + 1)}
        toast={toast}
      />
      <Toasts toasts={toasts} />
    </>
  );
}
