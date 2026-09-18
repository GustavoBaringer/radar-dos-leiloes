import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, LayoutGrid } from 'lucide-react';

interface Props {
  /** Cabeçalho fixo da folha: fica visível mesmo na altura mais baixa. */
  cabecalho: ReactNode;
  children: ReactNode;
  /** Muda quando o usuário escolhe um ponto — é o gatilho para a folha subir. */
  gatilho: string;
  /** Troca de visualização, repetida aqui porque a folha cheia cobre a barra. */
  aoVerGrade: () => void;
}

/** Espiada, metade e cheia — frações da JANELA, não do mapa. */
const ALTURAS = [0.22, 0.56, 0.94];

const janela = () => window.visualViewport?.height ?? window.innerHeight;

/**
 * A lista sobre o mapa, no celular.
 *
 * Medido em 390x844: ancorada na área do mapa, a altura cheia dava 522px — 94%
 * do mapa e só 62% da tela, porque o cabeçalho ocupa 289px que não saem da
 * frente. Por isso a folha é presa à JANELA: no topo ela cobre o cabeçalho, que
 * volta assim que se puxa para baixo.
 */
export function FolhaMapa({ cabecalho, children, gatilho, aoVerGrade }: Props) {
  const caixa = useRef<HTMLDivElement>(null);
  const rolo = useRef<HTMLDivElement>(null);
  const [nivel, setNivel] = useState(0);
  const [arrastando, setArrastando] = useState(false);
  const [altura, setAltura] = useState<number | null>(null);
  const gesto = useRef<{ y: number; h: number; doRolo: boolean; ativo: boolean } | null>(null);

  const alturaDe = useCallback((n: number) => Math.round(janela() * ALTURAS[n]), []);

  useEffect(() => { setAltura(alturaDe(nivel)); }, [nivel, alturaDe]);
  useEffect(() => {
    const onR = () => setAltura(alturaDe(nivel));
    window.addEventListener('resize', onR);
    window.visualViewport?.addEventListener('resize', onR);
    return () => {
      window.removeEventListener('resize', onR);
      window.visualViewport?.removeEventListener('resize', onR);
    };
  }, [nivel, alturaDe]);

  // Escolher um ponto levanta a folha até a metade: sem isso o usuário toca e
  // não vê resposta nenhuma, porque ela nasceu fora da tela.
  useEffect(() => {
    if (gatilho) setNivel((n) => (n === 0 ? 1 : n));
  }, [gatilho]);

  const noMaximo = nivel === ALTURAS.length - 1;

  /**
   * Quem manda no gesto: a folha ou a rolagem da lista.
   *
   * Arrastar só pela alça é o que o usuário reclamou. Mas entregar a folha o
   * gesto inteiro quebraria a rolagem da lista quando ela está cheia — daí a
   * regra: a lista só fica com o gesto quando está no máximo E já rolada, ou
   * quando está no máximo e o dedo sobe.
   */
  const donoEhAFolha = (doRolo: boolean, deltaY: number) => {
    if (!doRolo) return true;
    if (!noMaximo) return true;
    const rolado = (rolo.current?.scrollTop ?? 0) > 0;
    if (rolado) return false;
    return deltaY > 0; // dedo descendo com a lista no topo: a folha desce junto
  };

  const encaixa = () => {
    const f = (caixa.current?.getBoundingClientRect().height ?? 0) / janela();
    let melhor = 0;
    for (let i = 1; i < ALTURAS.length; i++) {
      if (Math.abs(ALTURAS[i] - f) < Math.abs(ALTURAS[melhor] - f)) melhor = i;
    }
    setNivel(melhor);
    setAltura(alturaDe(melhor));
  };

  return (
    <div
      className={`folha-mapa${arrastando ? ' arrastando' : ''}${noMaximo ? ' cheia' : ''}`}
      ref={caixa}
      style={altura != null ? { height: `${altura}px` } : undefined}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('a, button, select, input')) return;
        gesto.current = {
          y: e.clientY,
          h: caixa.current?.getBoundingClientRect().height ?? 0,
          doRolo: !!(e.target as HTMLElement).closest('.folha-rolo'),
          ativo: false,
        };
      }}
      onPointerMove={(e) => {
        const g = gesto.current;
        if (!g) return;
        const dy = e.clientY - g.y;
        if (!g.ativo) {
          if (Math.abs(dy) < 6) return;
          // A decisão é tomada UMA vez, no primeiro movimento: trocar de dono no
          // meio do gesto faz a folha pular enquanto a lista rola.
          if (!donoEhAFolha(g.doRolo, dy)) { gesto.current = null; return; }
          g.ativo = true;
          setArrastando(true);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
        const max = janela();
        setAltura(Math.max(46, Math.min(max, Math.round(g.h - dy))));
      }}
      onPointerUp={() => {
        const g = gesto.current;
        gesto.current = null;
        if (!g?.ativo) return;
        setArrastando(false);
        encaixa();
      }}
      onPointerCancel={() => {
        if (gesto.current?.ativo) { setArrastando(false); encaixa(); }
        gesto.current = null;
      }}
    >
      <div
        className="folha-puxador"
        role="slider"
        tabIndex={0}
        aria-label="Altura da lista"
        aria-valuemin={0}
        aria-valuemax={ALTURAS.length - 1}
        aria-valuenow={nivel}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { setNivel((n) => Math.min(ALTURAS.length - 1, n + 1)); e.preventDefault(); }
          else if (e.key === 'ArrowDown') { setNivel((n) => Math.max(0, n - 1)); e.preventDefault(); }
        }}
      >
        <i />
      </div>
      {/* Cheia, a folha cobre a barra de resultados: sem estes dois o usuário
          fica sem volta para o mapa e sem troca para a grade. */}
      {noMaximo && (
        <div className="folha-saidas">
          <button type="button" onClick={() => setNivel(0)}>
            <ChevronDown size={14} aria-hidden /> ver o mapa
          </button>
          <button type="button" onClick={aoVerGrade}>
            <LayoutGrid size={14} aria-hidden /> grade
          </button>
        </div>
      )}
      <div className="folha-cabecalho">{cabecalho}</div>
      <div className="folha-rolo" ref={rolo}>{children}</div>
    </div>
  );
}
