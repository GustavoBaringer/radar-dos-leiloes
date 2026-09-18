import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Menu, Search, X } from 'lucide-react';
import { MarcaRadar } from './MarcaRadar';

export type Aba = 'busca' | 'alertas' | 'cobertura';

interface Props {
  aba: Aba;
  aoTrocarAba: (a: Aba) => void;
  termo: string;
  aoDigitar: (v: string) => void;
  aoBuscar: () => void;
  aoVivo: boolean;
  naoVistos: number;
  /** Papel comum não vê Cobertura: cair nela deixaria a tela vazia. */
  mostraCobertura: boolean;
  /** Visitante sem sessão: nada que exija conta aparece. */
  publico?: boolean;
  /** Caminho para onde voltar depois de entrar. */
  voltarPara?: string;
}

export function AppHeader({
  aba, aoTrocarAba, termo, aoDigitar, aoBuscar, aoVivo, naoVistos, mostraCobertura, publico = false, voltarPara,
}: Props) {
  const [menuAberto, setMenuAberto] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMenuAberto(false);
  }, [aba]);

  const abas: Array<{ id: Aba; nome: string }> = [
    { id: 'busca', nome: 'Busca' },
    { id: 'alertas', nome: 'Alertas' },
    ...(mostraCobertura ? [{ id: 'cobertura' as const, nome: 'Cobertura' }] : []),
  ];

  function enviar(e: FormEvent) {
    e.preventDefault();
    // No celular o teclado só fecha quando o campo perde o foco. Vale para o
    // Enter e para o toque em Buscar, porque os dois caem aqui.
    campo.current?.blur();
    aoBuscar();
  }

  // Sem sessão: nenhum controle que dependa de conta. A busca, as abas e o
  // indicador "ao vivo" todos chamariam endpoint protegido e voltariam 401.
  if (publico) {
    return (
      <header className="topo">
        {/* `topo-publico` não é enfeite: a reordenação móvel do cabeçalho
            logado (marca/estado/menu numa linha, busca na de baixo) vazava
            para cá, onde os filhos são outros, e jogava o botão "Entrar" na
            frente da marca. */}
        <div className="faixa topo-inner topo-publico">
          <a className="logo" href="/" aria-label="Radar de Leilões — ir para a página inicial">
            <MarcaRadar tamanho={32} />
            <span className="logo-txt">Radar de Leilões</span>
          </a>
          {/* Leva o destino junto: sem `?de=`, entrar mandava o visitante para
              /busca e ele perdia o anúncio que tinha acabado de abrir. */}
          <a
            className="btn-buscar topo-entrar"
            href={voltarPara ? `/login?de=${encodeURIComponent(voltarPara)}` : '/login'}
          >
            Entrar
          </a>
        </div>
      </header>
    );
  }

  return (
    <header className="topo">
      <div className="faixa topo-inner">
        <a className="logo" href="/" aria-label="Radar de Leilões — ir para a página inicial">
          <MarcaRadar tamanho={32} />
          <span className="logo-txt">Radar de Leilões</span>
        </a>

        <form className="busca-topo" onSubmit={enviar} role="search">
          <label htmlFor="q" className="sr-only">
            Buscar lote por modelo
          </label>
          <Search size={16} className="busca-ico" aria-hidden />
          <input
            id="q"
            ref={campo}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="none"
            placeholder="Buscar por palavra-chave"
            value={termo}
            onChange={(e) => aoDigitar(e.target.value)}
          />
          <button type="submit" className="btn-buscar">
            Buscar
          </button>
        </form>

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
              {a.id === 'alertas' && naoVistos > 0 && (
                <span className="sino-badge mono" aria-label={`${naoVistos} não vistos`}>
                  {naoVistos}
                </span>
              )}
            </button>
          ))}
        </nav>

        <span className={`ws-dot${aoVivo ? ' on' : ''}`} title={aoVivo ? 'Conectado ao vivo' : 'Sem conexão ao vivo'}>
          <i className={aoVivo ? 'live-pulse' : ''} aria-hidden />
          <span className="ws-txt">ao vivo</span>
        </span>

        <button
          type="button"
          className="abre-menu"
          aria-expanded={menuAberto}
          aria-controls="menu-movel"
          aria-label={menuAberto ? 'Fechar menu' : 'Abrir menu'}
          onClick={() => setMenuAberto((v) => !v)}
        >
          {menuAberto ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
        </button>
      </div>

      {menuAberto && (
        <nav className="menu-movel" id="menu-movel" aria-label="Seções">
          {abas.map((a) => (
            <button key={a.id} onClick={() => aoTrocarAba(a.id)} className={aba === a.id ? 'on' : ''}>
              {a.nome}
            </button>
          ))}
          <a href="/">Página inicial</a>
        </nav>
      )}
    </header>
  );
}
