import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Share2 } from 'lucide-react';

/**
 * Compartilhar o anúncio.
 *
 * A capacidade do navegador NÃO é consultada durante o render: `navigator` não
 * existe no servidor, e um rótulo diferente dos dois lados quebraria a
 * hidratação do SSR — erro que esta tela já pagou uma vez com os `<link>` de
 * preload. O botão nasce igual em todo lugar e a decisão acontece no clique.
 *
 * Três caminhos, em ordem de preferência:
 *  1. `navigator.share` — a folha nativa do sistema, que é o que o celular espera;
 *  2. a área de transferência, com confirmação visível;
 *  3. seleção do texto, para o caso sem contexto seguro (HTTP na rede local),
 *     em que a área de transferência simplesmente não existe.
 */
export function BotaoCompartilhar({ titulo, descricao }: { titulo: string; descricao?: string }) {
  const [estado, setEstado] = useState<'parado' | 'copiado' | 'manual'>('parado');
  const [url, setUrl] = useState('');
  const campo = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const compartilhar = useCallback(async () => {
    // `location.href` é a origem por onde o visitante REALMENTE chegou — o
    // domínio do túnel, o de produção. Montar a URL de uma constante mandaria
    // localhost para o WhatsApp de alguém.
    const alvo = window.location.href;

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: titulo, text: descricao, url: alvo });
        return;
      } catch (e) {
        // Fechar a folha nativa lança AbortError. Isso é desistência do
        // usuário, não falha: cair para a cópia aqui seria copiar um link que
        // ele acabou de decidir não compartilhar.
        if ((e as Error)?.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(alvo);
      setEstado('copiado');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setEstado('parado'), 2400);
      return;
    } catch {
      /* sem contexto seguro ou sem permissão: cai para a seleção manual */
    }

    setUrl(alvo);
    setEstado('manual');
    setTimeout(() => campo.current?.select(), 30);
  }, [titulo, descricao]);

  if (estado === 'manual') {
    return (
      <div className="compartilhar-manual">
        <label htmlFor="urlCompartilhar" className="sr-only">
          Endereço deste anúncio
        </label>
        <input id="urlCompartilhar" ref={campo} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={() => setEstado('parado')} aria-label="Fechar">
          Pronto
        </button>
      </div>
    );
  }

  return (
    <button type="button" className="btn-compartilhar" onClick={compartilhar} aria-live="polite">
      {estado === 'copiado' ? <Check size={15} aria-hidden /> : <Share2 size={15} aria-hidden />}
      <span>{estado === 'copiado' ? 'Link copiado' : 'Compartilhar'}</span>
    </button>
  );
}
