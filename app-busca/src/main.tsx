import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App';
import type { Lot } from './lib/types';
import './styles.css';

declare global {
  interface Window {
    __LOTE__?: Lot;
    __PUBLICO__?: boolean;
  }
}

// Sem isto, qualquer exceção de render (ex.: resposta da API fora do contrato) deixava a tela em branco.
class Falha extends Component<{ children: ReactNode }, { erro: boolean }> {
  state = { erro: false };
  static getDerivedStateFromError() {
    return { erro: true };
  }
  render() {
    if (!this.state.erro) return this.props.children;
    return (
      <div className="falha-tela" role="alert">
        <h1>Algo deu errado ao montar esta tela.</h1>
        <p>Recarregue a página. Se continuar, tente de novo em alguns minutos.</p>
        <button type="button" className="btn-pri" onClick={() => location.reload()}>Recarregar</button>
      </div>
    );
  }
}

const raiz = document.getElementById('root')!;
const loteInicial = window.__LOTE__ ?? null;
const publico = window.__PUBLICO__ === true;

/**
 * Hidrata quando o servidor já mandou HTML (a página do lote vem renderizada
 * para o robô de busca ler); monta do zero no resto. Chamar createRoot sobre
 * marcação do servidor jogaria fora o HTML que acabou de chegar — e com ele o
 * conteúdo que o crawler indexou.
 */
const arvore = (
  <StrictMode>
    <Falha>
      <App loteInicial={loteInicial} publico={publico} />
    </Falha>
  </StrictMode>
);

if (raiz.hasChildNodes()) hydrateRoot(raiz, arvore);
else createRoot(raiz).render(arvore);
