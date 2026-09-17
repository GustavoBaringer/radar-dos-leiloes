import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import App from './App';
import type { Lot } from './lib/types';

/**
 * Render do servidor para /lote/:slug.
 *
 * Só esta rota tem SSR, e por um motivo concreto: é a página que traz busca
 * orgânica de cauda longa ("honda civic 2018 leilão"). O robô lê o HTML, não o
 * resultado do fetch. As outras rotas exigem sessão e não são indexáveis, então
 * renderizá-las no servidor custaria complexidade sem ganho nenhum.
 */
export function renderLote(lot: Lot, publico = false): string {
  return renderToString(
    <StrictMode>
      <App loteInicial={lot} publico={publico} />
    </StrictMode>,
  );
}
