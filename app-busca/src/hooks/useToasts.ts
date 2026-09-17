import { useCallback, useEffect, useRef, useState } from 'react';

/** Quantos avisos cabem na tela sem cobrir o conteúdo e a gaveta aberta. */
const VISIVEIS = 3;
const DURACAO_MS = 6000;

export interface Toast {
  id: number;
  texto: string;
}

/**
 * Avisos efêmeros.
 *
 * O limite de 3 não é estética: uma coleta grande dispara um aviso por lance e
 * a versão anterior empilhava 20+ caixas, que cobriam a tela inteira e a gaveta
 * aberta. O que chega novo empurra o mais antigo para fora em vez de somar.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const toast = useCallback((texto: string) => {
    const id = ++seq.current;
    setToasts((atuais) => [...atuais, { id, texto }].slice(-VISIVEIS));
    timers.current.set(
      id,
      setTimeout(() => {
        setToasts((atuais) => atuais.filter((t) => t.id !== id));
        timers.current.delete(id);
      }, DURACAO_MS),
    );
  }, []);

  // Sem isto, desmontar com avisos na tela deixa timers pendurados chamando
  // setState em componente morto — o aviso clássico no console.
  useEffect(() => {
    const mapa = timers.current;
    return () => {
      for (const t of mapa.values()) clearTimeout(t);
      mapa.clear();
    };
  }, []);

  return { toasts, toast };
}
