import { useEffect, useRef, useState } from 'react';
import { BellPlus } from 'lucide-react';
import { MarcaRadar } from './MarcaRadar';

export type Aba = 'busca' | 'alertas' | 'favoritos' | 'cobertura';

interface Props {
  aba: Aba;
  aoTrocarAba: (a: Aba) => void;
  aoVivo: boolean;
  naoVistos: number | null;
  nFavoritos?: number;
  mostraCobertura: boolean;
  aoCriarAlerta?: () => void;
  /** Visitante sem sessão: só a marca e o caminho para entrar. */
  publico?: boolean;
  /** Para onde o "Entrar" devolve depois do login. */
  voltarPara?: string;
}

export function AppHeader({
  aba, aoTrocarAba, aoVivo, naoVistos, nFavoritos, mostraCobertura, aoCriarAlerta, publico = false, voltarPara,
}: Props) {
  const [menuAberto, setMenuAberto] = useState(false);
  const botaoMenu = useRef<HTMLButtonElement>(null);
  const painelMenu = useRef<HTMLElement>(null);

  useEffect(() => {
    setMenuAberto(false);
  }, [aba]);

  useEffect(() => {
    if (!menuAberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuAberto(false);
      botaoMenu.current?.focus();
    };
    const fora = (e: PointerEvent) => {
      const alvo = e.target as Node;
      if (!painelMenu.current?.contains(alvo) && !botaoMenu.current?.contains(alvo)) setMenuAberto(false);
    };
    window.addEventListener('keydown', tecla);
    document.addEventListener('pointerdown', fora);
    return () => {
      window.removeEventListener('keydown', tecla);
      document.removeEventListener('pointerdown', fora);
    };
  }, [menuAberto]);

  const abas: Array<{ id: Aba; nome: string; n?: number; destaque?: boolean }> = [
    { id: 'busca', nome: 'Busca' },
    { id: 'alertas', nome: 'Alertas', n: naoVistos ?? undefined, destaque: true },
    { id: 'favoritos', nome: 'Favoritos', n: nFavoritos },
    ...(mostraCobertura ? [{ id: 'cobertura' as const, nome: 'Cobertura' }] : []),
  ];

  const util = (
    <div className="util">
      <div className="faixa util-in">
        {!publico && (
          <span className={`ws-dot${aoVivo ? ' on' : ''}`} title={aoVivo ? 'Lances chegam ao vivo' : 'Sem conexão ao vivo'}>
            <i className={aoVivo ? 'live-pulse' : ''} aria-hidden />
            <span className="ws-txt">{aoVivo ? 'Ao vivo: lances chegam sem recarregar' : 'Sem conexão ao vivo'}</span>
          </span>
        )}
        <span className="util-aviso">O Radar não é leiloeiro: cada lote leva ao site da fonte</span>
      </div>
    </div>
  );

  // Sem sessão: nenhum controle que dependa de conta. As abas e o indicador
  // "ao vivo" chamariam endpoint protegido e voltariam 401.
  if (publico) {
    return (
      <>
        {util}
        <header className="topo">
          {/* `topo-publico` não é enfeite: a reordenação móvel do cabeçalho
              logado vazava para cá e jogava o botão "Entrar" na frente da marca. */}
          <div className="faixa topo-inner topo-publico">
            <a className="logo" href="/" aria-label="Radar de Leilões — ir para a página inicial">
              <MarcaRadar tamanho={34} />
              <span className="logo-txt">Radar de Leilões</span>
            </a>
            {/* Leva o destino junto: sem `?de=`, entrar mandava o visitante para
                /busca e ele perdia o anúncio que tinha acabado de abrir. */}
            <a
              className="btn-cta topo-entrar"
              href={voltarPara ? `/login?de=${encodeURIComponent(voltarPara)}` : '/login'}
            >
              Entrar
            </a>
          </div>
        </header>
      </>
    );
  }

  return (
    <>
      {util}
      <header className="topo">
        <div className="faixa topo-inner">
          <a className="logo" href="/" aria-label="Radar de Leilões — ir para a página inicial">
            <MarcaRadar tamanho={34} />
            <span className="logo-txt">Radar de Leilões</span>
          </a>

          <nav className="abas" role="tablist" aria-label="Seções">
            {abas.map((a) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={aba === a.id}
                className={aba === a.id ? 'on' : ''}
                onClick={() => aoTrocarAba(a.id)}
              >
                {a.nome}
                {a.n != null && a.n > 0 && (
                  <span className={`sino-badge mono${a.destaque ? '' : ' neutro'}`} aria-label={a.destaque ? `${a.n} não vistos` : `${a.n}`}>
                    {a.n}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {aoCriarAlerta && (
            <button type="button" className="btn-cta topo-alerta" onClick={aoCriarAlerta}>
              <BellPlus size={17} aria-hidden />
              Criar alerta
            </button>
          )}

          <button
            type="button"
            ref={botaoMenu}
            className="abre-menu"
            aria-expanded={menuAberto}
            aria-controls="menu-movel"
            aria-label={menuAberto ? 'Fechar menu' : 'Abrir menu'}
            onClick={() => setMenuAberto((v) => !v)}
          >
            <i aria-hidden /><i aria-hidden /><i aria-hidden />
          </button>
        </div>

        {/* Sempre no DOM para animar abrir e fechar; inert tira do Tab quando fechado. */}
        {(
          <nav ref={painelMenu} className="menu-movel" id="menu-movel" aria-label="Seções" data-aberto={menuAberto ? '1' : '0'} inert={!menuAberto}>
            {abas.map((a) => (
              <button key={a.id} onClick={() => aoTrocarAba(a.id)} className={aba === a.id ? 'on' : ''}>
                {a.nome}
                {a.n != null && a.n > 0 && <span className={`sino-badge mono${a.destaque ? '' : ' neutro'}`}>{a.n}</span>}
              </button>
            ))}
            {aoCriarAlerta && <button onClick={aoCriarAlerta}>Criar alerta para esta busca</button>}
            <a href="/">Página inicial</a>
          </nav>
        )}
      </header>
    </>
  );
}
