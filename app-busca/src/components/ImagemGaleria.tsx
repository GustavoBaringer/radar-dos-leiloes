import { useEffect, useRef, useState } from 'react';

/** Retenta falhas temporárias do proxy sem deixar requisições rodando após sair do lote. */
export function ImagemGaleria({ src, alt, className, aoConcluir }: {
  src: string;
  alt: string;
  className?: string;
  aoConcluir: () => void;
}) {
  const [tentativa, setTentativa] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const concluida = useRef(false);
  const imagem = useRef<HTMLImageElement>(null);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined; }, []);

  function concluir() {
    if (concluida.current) return;
    concluida.current = true;
    if (timer.current !== undefined) clearTimeout(timer.current);
    aoConcluir();
  }

  function falhou() {
    if (timer.current !== undefined) return;
    if (tentativa >= 2) { concluir(); return; }
    timer.current = setTimeout(() => { timer.current = undefined; setTentativa((value) => value + 1); }, tentativa === 0 ? 500 : 1500);
  }

  // O HTML do SSR pode carregar a imagem antes de a hidratação registrar onLoad.
  useEffect(() => {
    if (!imagem.current?.complete) return;
    if (imagem.current.naturalWidth > 0) concluir();
    else falhou();
    // Cada tentativa remonta a imagem; os callbacks pertencem à mesma foto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tentativa]);

  return <img ref={imagem} key={tentativa} src={src} alt={alt} className={className} decoding="async" onLoad={concluir} onError={falhou} />;
}
