import { useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { Alerta, Hit } from '@/lib/types';
import { api } from '@/lib/api';
import { LABEL_CANAL } from '@/lib/labels';
import { dataCurta } from '@/lib/format';
import { ativarPush, podePush } from '@/lib/push';
import { LotCard } from '@/components/LotCard';

interface Props {
  aoAbrirLote: (id: number) => void;
  toast: (t: string) => void;
  aoEditar: (a: Alerta) => void;
  /** Sobe quando um alerta é criado/editado fora daqui, para recarregar. */
  versao: number;
  aoContarNaoVistos: (n: number) => void;
  favoritos: Set<number>;
  aoFavoritar: (id: number) => void;
}

export function Alertas({
  aoAbrirLote, toast, aoEditar, versao, aoContarNaoVistos, favoritos, aoFavoritar,
}: Props) {
  const [alertas, setAlertas] = useState<Alerta[] | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [apagando, setApagando] = useState<number | null>(null);
  const [permissao, setPermissao] = useState<NotificationPermission | 'indisponivel'>('indisponivel');

  async function carregar() {
    try {
      const [a, h] = await Promise.all([api.alertas(), api.hits()]);
      setAlertas(a);
      setHits(h);
      aoContarNaoVistos(h.filter((x) => !x.seen).length);
      setErro(null);
    } catch (e) {
      setErro(String((e as Error)?.message ?? e));
    }
  }

  useEffect(() => {
    void carregar();
    // Entrar na aba marca os hits como vistos — o sino zera ao ser lido.
    api.marcarHitsVistos().then(() => aoContarNaoVistos(0)).catch(() => {});
    if (typeof Notification !== 'undefined') setPermissao(Notification.permission);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versao]);

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
  }

  return (
    <main className="faixa sec">
      <h1 className="page-head">Alertas</h1>
      <p className="page-sub">
        Cada alerta guarda uma busca. Quando um lote novo entra no índice e casa com ela, você é
        avisado. O casamento usa o mesmo dicionário de marca e modelo da busca, então "volkswagen
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

      <h2 className="sub-head">Meus alertas</h2>
      {erro ? (
        <div className="empty">Não foi possível carregar os alertas ({erro}).</div>
      ) : !alertas ? (
        <div className="empty">Carregando…</div>
      ) : alertas.length === 0 ? (
        <div className="empty">Nenhum alerta ainda. Faça uma busca e clique em "Criar alerta".</div>
      ) : (
        <div className="lista-alertas">
          {alertas.map((a) => (
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

      <h2 className="sub-head">Lotes encontrados</h2>
      {hits.length === 0 ? (
        <div className="empty">
          Nada encontrado ainda. O alerta dispara quando um lote novo casar com a sua busca.
        </div>
      ) : (
        // Mesmo cartão da listagem, não uma segunda lista: manter dois
        // renderizadores era garantia de divergirem.
        <div className="grade">
          {hits.map((h) => (
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
    </main>
  );
}
