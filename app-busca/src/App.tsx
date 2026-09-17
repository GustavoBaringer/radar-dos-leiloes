import { useCallback, useEffect, useRef, useState } from 'react';
import type { Alerta, Lot, WsMessage } from '@/lib/types';
import { api } from '@/lib/api';
import { type EstadoBusca, ESTADO_VAZIO, contaFiltros, estadoDaUrl, urlDoEstado, CAMPOS_FILTRO, MULTI_IDS } from '@/lib/filtros';
import { money } from '@/lib/format';
import { idDoSlug, slugDoLote } from '@/lib/slug';
import { AppHeader, type Aba } from '@/components/AppHeader';
import { Rodape } from '@/components/Rodape';
import { LotDrawer } from '@/components/LotDrawer';
import { Toasts } from '@/components/Toasts';
import { DialogoAlerta, type AlvoDialogo } from '@/components/DialogoAlerta';
import { Busca } from '@/views/Busca';
import { Alertas } from '@/views/Alertas';
import { Cobertura } from '@/views/Cobertura';
import { useToasts } from '@/hooks/useToasts';
import { useWebSocket } from '@/hooks/useWebSocket';

function abaDoCaminho(p: string): Aba {
  if (p === '/alertas') return 'alertas';
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
export default function App({ loteInicial = null }: { loteInicial?: Lot | null }) {
  const [estado, setEstado] = useState<EstadoBusca>(() =>
    typeof window === 'undefined' ? ESTADO_VAZIO : estadoDaUrl(window.location.search),
  );
  const [aba, setAba] = useState<Aba>(() =>
    typeof window === 'undefined' ? 'busca' : abaDoCaminho(window.location.pathname),
  );
  const [lote, setLote] = useState<Lot | null>(loteInicial);
  const [papel, setPapel] = useState<string>('comum');
  const [naoVistos, setNaoVistos] = useState(0);
  const [versaoAlertas, setVersaoAlertas] = useState(0);
  const [alvoDialogo, setAlvoDialogo] = useState<AlvoDialogo | null>(null);
  const [lancesAoVivo, setLances] = useState<Record<number, number>>({});
  const [piscando, setPiscando] = useState<Set<number>>(new Set());
  const { toasts, toast } = useToasts();
  // O foco volta para o cartão de origem: sem isto, quem navega por teclado era
  // devolvido ao topo da página a cada lote aberto.
  const focoAnterior = useRef<HTMLElement | null>(null);

  /* ---------------- papel ---------------- */
  useEffect(() => {
    // Esconder a aba é cortesia visual; quem barra de fato é o 403 das rotas.
    api.eu().then((r) => setPapel(r.papel ?? 'comum')).catch(() => setPapel('comum'));
  }, []);

  /* ---------------- rotas ---------------- */

  const abrirLote = useCallback(async (id: number, empilhar = true) => {
    focoAnterior.current = document.activeElement as HTMLElement;
    try {
      const l = await api.lote(id);
      setLote(l);
      // A URL do lote é compartilhável: quem recebe o link abre a gaveta direto.
      if (empilhar) history.pushState({ lote: l.id }, '', `/lote/${slugDoLote(l)}`);
    } catch {
      toast('Lote não encontrado.');
    }
  }, [toast]);

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
      const id = idDoSlug(location.pathname.slice(6));
      if (id) void abrirLote(id, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * replaceState e não pushState: cada troca de filtro empilharia uma entrada e
   * o "voltar" viraria um desfazer clique a clique. Quem empilha é a troca de
   * aba e a abertura do lote.
   */
  useEffect(() => {
    if (aba !== 'busca' || location.pathname.startsWith('/lote/')) return;
    const alvo = urlDoEstado(estado);
    if (location.pathname + location.search !== alvo) history.replaceState(history.state, '', alvo);
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
        const id = idDoSlug(p.slice(6));
        if (id) void abrirLote(id, false);
        return;
      }
      setLote(null);
      setAba(abaDoCaminho(p));
      // Voltar para uma URL de busca diferente tem de repintar os filtros.
      setEstado(estadoDaUrl(location.search));
    }
    window.addEventListener('popstate', aoVoltar);
    return () => window.removeEventListener('popstate', aoVoltar);
  }, [abrirLote]);

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
      setNaoVistos((n) => n + msg.disparos.length);
      for (const d of msg.disparos.slice(0, 3)) toast(`Alerta "${d.label}": ${d.title.slice(0, 40)}`);
      if (aba === 'alertas') setVersaoAlertas((v) => v + 1);
    }
  }, [papel, aba, toast]);

  const aoVivo = useWebSocket(aoReceber);

  /* ---------------- filtros ---------------- */

  const mudar = useCallback((patch: Partial<EstadoBusca>) => {
    setEstado((e) => ({ ...e, ...patch, multi: patch.multi ?? e.multi }));
  }, []);

  const limpar = useCallback(() => setEstado({ ...ESTADO_VAZIO, multi: { ...ESTADO_VAZIO.multi } }), []);

  /** O alerta guarda a busca da tela: termo + filtros ativos. */
  const abrirDialogoCriar = useCallback(() => {
    const filtros: Record<string, string | boolean> = {};
    for (const id of CAMPOS_FILTRO) if (estado[id]) filtros[id] = estado[id];
    for (const id of MULTI_IDS) if (estado.multi[id].length) filtros[id] = estado.multi[id].join(',');
    if (estado.onlyWithPhoto) filtros.onlyWithPhoto = true;
    const q = estado.q.trim();
    if (!q && !Object.keys(filtros).length) {
      toast('Faça uma busca ou escolha um filtro antes de criar o alerta.');
      return;
    }
    setAlvoDialogo({
      alerta: null,
      label: q || 'Meus filtros',
      q,
      filtros,
      resumo: [q ? `busca "${q}"` : null, contaFiltros(estado) ? `${contaFiltros(estado)} filtro(s)` : null]
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

  return (
    <>
      <AppHeader
        aba={aba}
        aoTrocarAba={trocarAba}
        termo={estado.q}
        aoDigitar={(v) => setEstado((e) => ({ ...e, q: v }))}
        aoBuscar={() => {
          // Buscar de dentro de Cobertura ou Alertas tem de trazer o usuário
          // para o resultado; antes a busca rodava numa aba que ele não via.
          setAba('busca');
          setEstado((e) => ({ ...e, page: 1 }));
        }}
        aoVivo={aoVivo}
        naoVistos={naoVistos}
        mostraCobertura={papel === 'admin'}
      />

      {aba === 'busca' && (
        <Busca
          estado={estado}
          aoMudar={mudar}
          aoLimpar={limpar}
          aoAbrirLote={abrirLote}
          aoCriarAlerta={abrirDialogoCriar}
          lancesAoVivo={lancesAoVivo}
          piscando={piscando}
        />
      )}
      {aba === 'alertas' && (
        <Alertas
          aoAbrirLote={abrirLote}
          toast={toast}
          aoEditar={abrirDialogoEditar}
          versao={versaoAlertas}
          aoContarNaoVistos={setNaoVistos}
        />
      )}
      {aba === 'cobertura' && papel === 'admin' && <Cobertura />}

      <Rodape />
      <LotDrawer lot={lote} aoFechar={() => fecharGaveta()} />
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
