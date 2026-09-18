import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  /** Cabeçalho fixo da folha: fica visível mesmo na altura mais baixa. */
  cabecalho: ReactNode;
  children: ReactNode;
  /** Muda quando o usuário escolhe um ponto — é o gatilho para a folha subir. */
  gatilho: string;
}

/** Espiada, metade e cheia. É o que separa "vejo o mapa" de "leio a lista". */
const ALTURAS = [0.22, 0.56, 0.94];

/**
 * A lista sobre o mapa, no celular.
 *
 * Padrão escolhido depois de comparar os três possíveis: a pergunta que o mapa
 * responde é "o que tem AQUI", e alternar ou dividir fazem perder o "aqui" na
 * hora de ler a resposta.
 */
export function FolhaMapa({ cabecalho, children, gatilho }: Props) {
  const caixa = useRef<HTMLDivElement>(null);
  const [nivel, setNivel] = useState(0);
  const [arrastando, setArrastando] = useState(false);
  const [altura, setAltura] = useState<number | null>(null);
  const arrasto = useRef<{ y: number; h: number } | null>(null);

  const disponivel = useCallback(() => {
    const pai = caixa.current?.parentElement;
    return pai ? pai.getBoundingClientRect().height : window.innerHeight;
  }, []);

  useEffect(() => {
    setAltura(Math.round(disponivel() * ALTURAS[nivel]));
  }, [nivel, disponivel]);

  useEffect(() => {
    const onR = () => setAltura(Math.round(disponivel() * ALTURAS[nivel]));
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, [nivel, disponivel]);

  // Escolher um ponto levanta a folha até a metade: sem isso o usuário toca e
  // não vê resposta nenhuma, porque ela nasceu fora da tela.
  useEffect(() => {
    if (gatilho) setNivel((n) => (n === 0 ? 1 : n));
  }, [gatilho]);

  return (
    <div
      className={`folha-mapa${arrastando ? ' arrastando' : ''}`}
      ref={caixa}
      style={altura != null ? { height: `${altura}px` } : undefined}
    >
      <div
        className="folha-puxador"
        role="slider"
        tabIndex={0}
        aria-label="Altura da lista"
        aria-valuemin={0}
        aria-valuemax={ALTURAS.length - 1}
        aria-valuenow={nivel}
        onPointerDown={(e) => {
          arrasto.current = { y: e.clientY, h: caixa.current?.getBoundingClientRect().height ?? 0 };
          setArrastando(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const a = arrasto.current;
          if (!a) return;
          const max = disponivel();
          setAltura(Math.max(46, Math.min(max, Math.round(a.h + (a.y - e.clientY)))));
        }}
        onPointerUp={() => {
          if (!arrasto.current) return;
          arrasto.current = null;
          setArrastando(false);
          // Encaixa na altura mais próxima: folha parada no meio não é estado, é acidente.
          const f = (caixa.current?.getBoundingClientRect().height ?? 0) / disponivel();
          let melhor = 0;
          for (let i = 1; i < ALTURAS.length; i++) {
            if (Math.abs(ALTURAS[i] - f) < Math.abs(ALTURAS[melhor] - f)) melhor = i;
          }
          setNivel(melhor);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { setNivel((n) => Math.min(ALTURAS.length - 1, n + 1)); e.preventDefault(); }
          else if (e.key === 'ArrowDown') { setNivel((n) => Math.max(0, n - 1)); e.preventDefault(); }
        }}
      >
        <i />
      </div>
      <div className="folha-cabecalho">{cabecalho}</div>
      <div className="folha-rolo">{children}</div>
    </div>
  );
}
