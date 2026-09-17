import { StrictMode } from 'react';
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
    <App loteInicial={loteInicial} publico={publico} />
  </StrictMode>
);

if (raiz.hasChildNodes()) hydrateRoot(raiz, arvore);
else createRoot(raiz).render(arvore);
