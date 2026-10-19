import { pathToFileURL } from 'node:url';

export type LotRenderer = (lot: unknown, publico?: boolean) => string;
const renderers = new Map<string, Promise<LotRenderer | null>>();

export function loadLotRenderer(appDist: string): Promise<LotRenderer | null> {
  let pending = renderers.get(appDist);
  if (!pending) {
    pending = import(pathToFileURL(`${appDist}/server/entry-server.js`).href)
      .then(module => typeof module.renderLote === 'function' ? module.renderLote as LotRenderer : null)
      .catch(() => null);
    renderers.set(appDist, pending);
  }
  return pending;
}

export function formatMoney(value: number | null): string | null {
  return value == null ? null : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(value);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
