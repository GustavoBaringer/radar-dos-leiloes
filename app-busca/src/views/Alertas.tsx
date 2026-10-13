import { useEffect, useRef, useState } from 'react';
import { Pencil, Search, Trash2 } from 'lucide-react';
import type { Alerta, Hit } from '@/lib/types';
import type { StatusNotificacoes } from '@/lib/types';
import type { FavoriteReadStamp } from '@/lib/favorite-context';
import { api } from '@/lib/api';
import { LABEL_CANAL } from '@/lib/labels';
import { dataCurta } from '@/lib/format';
import { ativarPush, podePush, sincronizarPushAutorizado, estadoPush, type EstadoPush } from '@/lib/push';
import { LotCard } from '@/components/LotCard';
import { Paginacao } from '@/components/Paginacao';

interface Props {
  aoAbrirLote: (id: number) => void;
  toast: (t: string) => void;
  aoEditar: (a: Alerta) => void;
  /** Abre a busca com os filtros do alerta já aplicados. */
  aoAplicar: (a: Alerta) => void;
  /** Sobe quando um alerta é criado/editado fora daqui, para recarregar. */
  versao: number;
  aoContarNaoVistos: (n: number) => void;
  favoritos: Set<number>;
  aoFavoritar: (id: number) => void;
  aoConhecerLotes: (lotes: Hit[], stamp?: FavoriteReadStamp) => void;
  iniciarLeituraFavoritos: () => FavoriteReadStamp;
}

export function Alertas({
  aoAbrirLote, toast, aoEditar, aoAplicar, versao, aoContarNaoVistos, favoritos, aoFavoritar, aoConhecerLotes, iniciarLeituraFavoritos,
}: Props) {
  const leitura = useRef(0);
  const [alertId, setAlertId] = useState<number | null | undefined>(undefined);
  const [alertas, setAlertas] = useState<{ items: Alerta[]; page: number; hasMore: boolean } | null>(null);
  const [hits, setHits] = useState<{ items: Hit[]; page: number; hasMore: boolean } | null>(null);
  const [alertPage, setAlertPage] = useState(1);
  const [hitPage, setHitPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [apagando, setApagando] = useState<number | null>(null);
  const [permissao, setPermissao] = useState<NotificationPermission | 'indisponivel'>('indisponivel');
  const [canais, setCanais] = useState<StatusNotificacoes | null>(null);
  const [navegador, setNavegador] = useState<EstadoPush | null>(null);
  const [testando, setTestando] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(location.search).get('alertId');
    const id = value && /^\d+$/.test(value) ? Number(value) : null;
    setAlertId(id && Number.isSafeInteger(id) && id > 0 ? id : null);
  }, []);

  function mostrarTodos() {
    setAlertId(null);
    setHitPage(1);
    history.replaceState(history.state, '', '/alertas');
  }

  async function carregar() {
    if (alertId === undefined) return;
    const request = ++leitura.current;
    const favoriteStamp = iniciarLeituraFavoritos();
    setLoading(true);
    try {
      const [a, h] = await Promise.all([api.alertas(alertPage), api.hits(hitPage, undefined, alertId ?? undefined)]);
      if (request !== leitura.current) return;
      setAlertas(a);
      setHits(h);
      aoConhecerLotes(h.items, favoriteStamp);
      setErro(null);
      // Marca somente após carregar os resultados com sucesso.
      void api.marcarHitsVistos(alertId ?? undefined).then(() => api.eu()).then((summary) => {
        if (request === leitura.current) aoContarNaoVistos(summary.unreadAlertCount ?? 0);
      }).catch(() => {});
    } catch (e) {
      if (request !== leitura.current) return;
      setErro(String((e as Error)?.message ?? e));
    } finally { if (request === leitura.current) setLoading(false); }
  }

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versao, alertPage, hitPage, alertId]);

  useEffect(() => {
    if (typeof Notification !== 'undefined') setPermissao(Notification.permission);
    let ativo = true;
    // Reconcilia primeiro (repara inscrição perdida) e só depois mostra o que
    // falhou: um diagnóstico feito sobre uma inscrição morta não vale nada.
    void sincronizarPushAutorizado().then((r) => {
      if (ativo && !r.ok && r.motivo && Notification.permission === 'denied') toast(r.motivo);
    }).catch((e) => {
      if (ativo) toast(`Não foi possível sincronizar notificações: ${(e as Error)?.message ?? e}`);
    });
    return () => { ativo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Retrato dos dois lados da cadeia: o que o navegador tem e o que o servidor entrega. */
  async function carregarEstado() {
    const [doNavegador, doServidor] = await Promise.allSettled([estadoPush(), api.statusNotificacoes()]);
    setNavegador(doNavegador.status === 'fulfilled' ? doNavegador.value : null);
    if (doServidor.status === 'fulfilled') setCanais(doServidor.value);
  }

  useEffect(() => {
    void carregarEstado().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apagar(id: number) {
    setApagando(id);
    try {
      await api.apagarAlerta(id);
      toast('Alerta removido.');
      await carregar();
    } catch (e) {
      toast(`Não foi possível remover: ${(e as Error)?.message ?? e}`);
    } finally {
      setApagando(null);
    }
  }

  async function ligarPush() {
    const r = await ativarPush();
    toast(r.ok ? 'Notificações ativadas neste aparelho.' : (r.motivo ?? 'Não foi possível ativar.'));
    if (typeof Notification !== 'undefined') setPermissao(Notification.permission);
    await carregarEstado().catch(() => undefined);
  }

  /**
   * Teste de ponta a ponta: reconcilia a inscrição, manda um push de verdade e
   * mostra a resposta por aparelho. Era o que faltava para distinguir "o servidor
   * não entregou" de "o navegador não exibiu" — os dois casos aparecem iguais na
   * tela, com o alerta visível só quando a plataforma é aberta.
   */
  async function testarNotificacao() {
    setTestando(true);
    try {
      const reparo = await sincronizarPushAutorizado();
      if (!reparo.ok) {
        toast(reparo.motivo ?? 'Este navegador não está com push pronto.');
        await carregarEstado().catch(() => undefined);
        return;
      }
      const r = await api.testarPush();
      const detalhe = r.dispositivos.map((d) => `${d.host}: ${d.erro ?? d.status}`).join(' · ');
      if (!r.configurado) toast('O servidor não tem chave VAPID configurada.');
      else if (!r.inscricoes) toast('Nenhum aparelho inscrito no servidor. Clique em "Ativar" neste aparelho.');
      else if (r.entregues) toast(`Servidor entregou para ${r.entregues}/${r.inscricoes} aparelho(s) — ${detalhe}. Apareceu no aparelho?`);
      else toast(`Nenhum aparelho aceitou — ${detalhe || 'sem detalhe'}.`);
      await carregarEstado().catch(() => undefined);
    } catch (e) {
      toast(`Não foi possível testar: ${(e as Error)?.message ?? e}`);
    } finally {
      setTestando(false);
    }
  }

  return (
    <main className="faixa sec">
      <h1 className="page-head">Alertas</h1>
      <p className="page-sub">
        Cada alerta guarda uma busca. Os novos lotes encontrados em cada coleta são agrupados
        em uma única notificação por alerta. O casamento usa o mesmo dicionário de marca e modelo da busca, então "volkswagen
        taos" não dispara por um "taos" solto numa descrição.
      </p>

      {podePush() && permissao !== 'granted' && (
        <div className="aviso">
          <span>Ative a notificação do navegador para receber alerta mesmo com a aba fechada.</span>
          <button className="btn-pri" onClick={ligarPush}>Ativar</button>
        </div>
      )}
      {typeof window !== 'undefined' && !window.isSecureContext && (
        <div className="aviso">
          Notificação do navegador exige HTTPS. Abra pelo endereço https desta máquina para ativar.
        </div>
      )}
      {typeof location !== 'undefined' && location.protocol === 'https:' && permissao !== 'granted' && (
        <div className="aviso">
          {/* No celular o certificado próprio não basta: o Chrome só registra
              service worker sobre certificado CONFIÁVEL. */}
          No celular, antes de ativar: instale a autoridade local em Ajustes → Segurança → Instalar
          certificado → Certificado CA. <a href="/ca.crt" download>Baixar certificado</a>
        </div>
      )}

      <div className="aviso">
        <span>
          Notificações — navegador: {navegador?.permissao === 'granted' ? 'permitidas' : navegador?.permissao ?? 'indisponível'}
          {navegador ? (navegador.inscrito ? ' · aparelho inscrito' : ' · aparelho sem inscrição') : ''}
          {canais ? ` · servidor: push ${canais.canais.push ? 'pronto' : 'sem chave'} · e-mail ${canais.canais.email ? 'pronto' : 'NÃO CONFIGURADO'}` : ''}
        </span>
        <button className="btn-pri" onClick={() => void testarNotificacao()} disabled={testando}>
          {testando ? 'Testando…' : 'Testar notificação'}
        </button>
      </div>
      {canais && !canais.canais.email && (
        <div className="aviso">
          Este servidor não tem e-mail configurado. Alertas com o canal de e-mail não chegam por e-mail até o SMTP ser configurado.
        </div>
      )}

      <h2 className="sub-head">Meus alertas</h2>
      {erro ? (
        <div className="empty">
          Não foi possível carregar os alertas ({erro}).{' '}
          <button type="button" className="btn-clear tentar" onClick={() => void carregar()}>Tentar de novo</button>
        </div>
      ) : !alertas ? (
        <div className="empty">Carregando…</div>
      ) : alertas.items.length === 0 ? (
        <div className="empty">Nenhum alerta ainda. Faça uma busca e clique em "Criar alerta".</div>
      ) : (
        <div className="lista-alertas">
          <p className="page-sub">Exibindo {alertas.items.length} alertas nesta página.</p>
          {alertas.items.map((a) => (
            <div className="alerta-item" key={a.id}>
              <div className="alerta-txt">
                <b>{a.label}</b>
                <span className="alerta-canais">
                  {a.channels.map((c) => LABEL_CANAL[c] ?? c).join(' · ')}
                </span>
              </div>
              <span className="alerta-lotes mono">
                {a.total} lote{a.total === 1 ? '' : 's'}
              </span>
              <button className="ico" onClick={() => aoAplicar(a)} aria-label={`Aplicar filtros de ${a.label}`} title="Aplicar filtros na busca">
                <Search size={15} aria-hidden />
              </button>
              <button className="ico" onClick={() => aoEditar(a)} aria-label={`Editar ${a.label}`} title="Editar alerta">
                <Pencil size={15} aria-hidden />
              </button>
              <button
                className="ico" onClick={() => apagar(a.id)} disabled={apagando === a.id}
                aria-label={`Remover ${a.label}`} title="Remover alerta"
              >
                <Trash2 size={15} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {alertas && <Paginacao label="Páginas de alertas" page={alertas.page} hasMore={alertas.hasMore} loading={loading} onPage={setAlertPage} />}

      <h2 className="sub-head">Lotes encontrados</h2>
      {alertId != null && (
        <p className="page-sub">
          Exibindo lotes do alerta selecionado.{' '}
          <button type="button" className="btn-clear" onClick={mostrarTodos}>Ver todos os alertas</button>
        </p>
      )}
      {/* Com a carga falhando, "Nada encontrado" afirmava um resultado que não existe. */}
      {erro ? (
        <div className="empty">Os lotes dos alertas também não carregaram.</div>
      ) : !alertas ? (
        <div className="empty">Carregando…</div>
      ) : !hits || hits.items.length === 0 ? (
        <div className="empty">
          Nada encontrado ainda. O alerta dispara quando um lote novo casar com a sua busca.
        </div>
      ) : (
        // Mesmo cartão da listagem, não uma segunda lista: manter dois
        // renderizadores era garantia de divergirem.
        <div className="grade">
          {hits.items.map((h) => (
            <LotCard
              key={`${h.id}-${h.hit_em}`}
              lot={h}
              aoAbrir={aoAbrirLote}
              destaque={!h.seen}
              favoritado={favoritos.has(h.id)}
              aoFavoritar={aoFavoritar}
              rodape={
                <div className="hit-alerta">
                  <span className="hit-termo">{h.labels.join(', ')}</span>
                  <span className="hit-quando mono">{dataCurta(h.hit_em)}</span>
                </div>
              }
            />
          ))}
        </div>
      )}
      {hits && <Paginacao label="Páginas de lotes encontrados" page={hits.page} hasMore={hits.hasMore} loading={loading} onPage={setHitPage} />}
    </main>
  );
}
