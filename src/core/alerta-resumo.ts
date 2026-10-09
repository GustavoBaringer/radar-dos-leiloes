import type { Disparo } from './alerts.js';

/** Um resumo por dono/alerta no conjunto recebido de uma coleta. */
export function agruparDisparos(disparos: readonly Disparo[]): Disparo[][] {
  const grupos = new Map<string, Map<number, Disparo>>();
  for (const d of disparos) {
    const chave = `${d.ownerId}:${d.alertId}`;
    let lotes = grupos.get(chave);
    if (!lotes) grupos.set(chave, lotes = new Map());
    if (!lotes.has(d.lotId)) lotes.set(d.lotId, d);
  }
  return [...grupos.values()].map((lotes) => [...lotes.values()]);
}

export function mensagemResumo(label: string, quantidade: number): string {
  return `Encontramos ${quantidade} ${quantidade === 1 ? 'novo lote' : 'novos lotes'} para o seu alerta "${label}"`;
}

export const urlDoAlerta = (alertId: number) => `/alertas?alertId=${alertId}`;
