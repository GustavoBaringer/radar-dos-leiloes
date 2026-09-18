import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { Alerta } from '@/lib/types';
import { api } from '@/lib/api';
import { ativarPush, pushInscrito } from '@/lib/push';

export interface AlvoDialogo {
  alerta: Alerta | null;
  label: string;
  q: string;
  filtros: Record<string, string | boolean>;
  resumo: string;
}

interface Props {
  alvo: AlvoDialogo | null;
  aoFechar: () => void;
  aoSalvar: () => void;
  toast: (t: string) => void;
}

export function DialogoAlerta({ alvo, aoFechar, aoSalvar, toast }: Props) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState('');
  const [canalPush, setCanalPush] = useState(false);
  const [canalEmail, setCanalEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!alvo) {
      dlg.current?.close();
      return;
    }
    setLabel(alvo.label);
    const canais = alvo.alerta?.channels ?? ['sino'];
    setCanalPush(canais.includes('push'));
    setCanalEmail(canais.includes('email'));
    setEmail(alvo.alerta?.email ?? '');
    setSalvando(false);
    if (!dlg.current?.open) dlg.current?.showModal();
  }, [alvo]);

  if (!alvo) return null;
  const editando = alvo.alerta !== null;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!alvo) return;
    setSalvando(true);
    try {
      const canais = ['sino'];
      if (canalPush) {
        // Push é opcional: se o navegador recusar, o alerta ainda é criado com
        // os outros canais em vez de a criação inteira falhar.
        try {
          if ((await pushInscrito()) || (await ativarPush()).ok) canais.push('push');
          else toast('Push indisponível. Alerta criado sem ele.');
        } catch (err) {
          toast(`Push indisponível: ${(err as Error)?.message ?? 'erro'}. Alerta criado sem ele.`);
        }
      }
      if (canalEmail) {
        if (!email.trim()) {
          toast('Informe o e-mail ou desmarque o canal de e-mail.');
          setSalvando(false);
          return;
        }
        canais.push('email');
      }

      const nome = label.trim() || alvo.q.trim() || 'Alerta';
      const corpo = editando
        ? { label: nome, channels: canais, email: canalEmail ? email.trim() : null }
        : { label: nome, q: alvo.q.trim(), filters: alvo.filtros, channels: canais, email: canalEmail ? email.trim() : null };

      const r = editando
        ? ((await api.editarAlerta(alvo.alerta!.id, corpo)) as { no_indice_agora?: number })
        : await api.criarAlerta(corpo);

      toast(
        editando
          ? `Alerta "${nome}" atualizado.`
          // O número é INFORMATIVO: diz quantos lotes o alerta acharia hoje,
          // e não quantos foram avisados. O alerta avisa do que entra a partir
          // de agora, então prometer "já encontrados" seria mentir sobre o que
          // vai aparecer na aba.
          : `Alerta "${nome}" criado. Você será avisado dos próximos lotes que casarem` +
            `${r?.no_indice_agora ? ` (${r.no_indice_agora} no índice casam hoje — use a busca para vê-los)` : ''}.`,
      );
      aoSalvar();
      aoFechar();
    } catch (err) {
      // Sem este catch, qualquer exceção deixava o diálogo aberto e mudo.
      toast(`Não foi possível salvar: ${(err as Error)?.message ?? err}`);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <dialog ref={dlg} className="dlg" onCancel={aoFechar} onClose={aoFechar}>
      <form onSubmit={enviar}>
        <h3>{editando ? 'Editar alerta' : 'Criar alerta'}</h3>
        <p className="dlg-sub">{alvo.resumo}</p>

        <label htmlFor="alertaLabel">Nome do alerta</label>
        <input id="alertaLabel" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />

        <fieldset>
          <legend>Como quer ser avisado</legend>
          <label className="chk">
            <input type="checkbox" checked disabled />
            <span>Sino aqui na plataforma</span>
          </label>
          <label className="chk">
            <input type="checkbox" checked={canalPush} onChange={(e) => setCanalPush(e.target.checked)} />
            <span>Notificação no navegador</span>
          </label>
          <label className="chk">
            <input type="checkbox" checked={canalEmail} onChange={(e) => setCanalEmail(e.target.checked)} />
            <span>E-mail</span>
          </label>
          {canalEmail && (
            <input
              type="email" placeholder="seu@email.com" value={email}
              onChange={(e) => setEmail(e.target.value)} aria-label="E-mail para o alerta"
            />
          )}
        </fieldset>

        <div className="dlg-acoes">
          <button type="button" className="btn-sec" onClick={aoFechar}>Cancelar</button>
          <button type="submit" className="btn-pri" disabled={salvando}>
            {salvando ? 'Salvando…' : editando ? 'Salvar' : 'Criar alerta'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
