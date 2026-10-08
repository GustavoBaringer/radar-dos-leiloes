import { useEffect, useState } from 'react';

/** Relógio que só bate quando há o que contar: um intervalo por cartão parado custaria à toa. */
export function useAgora(ligado: boolean, ms = 1000): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    if (!ligado) return;
    setAgora(Date.now());
    const t = setInterval(() => setAgora(Date.now()), ms);
    return () => clearInterval(t);
  }, [ligado, ms]);
  return agora;
}
