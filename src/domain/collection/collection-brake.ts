/** Falhas seguidas que fecham o freio. */
export const FALHAS_PARA_FREAR = 5;
/** Quanto tempo o freio segura antes de deixar passar a sonda. */
export const DESCANSO_FREIO_H = 6;

export interface Tentativa { ok: boolean | null; startedAt: Date }
export interface Veredito {
  permite: boolean;
  seguidas: number;
  motivo: 'normal' | 'sonda' | 'freado';
  proxima?: Date;
}

export function decideFreio(recentes: Tentativa[], agora = new Date(), cfg: { falhas?: number; descansoH?: number } = {}): Veredito {
  const limite = cfg.falhas ?? FALHAS_PARA_FREAR;
  const descansoMs = (cfg.descansoH ?? DESCANSO_FREIO_H) * 3_600_000;
  const ordenadas = [...recentes].sort((a, b) => +b.startedAt - +a.startedAt);
  let seguidas = 0;
  let ultimaFalha: Date | undefined;
  for (const t of ordenadas) {
    if (t.ok === null) continue;
    if (t.ok) break;
    seguidas++;
    ultimaFalha ??= t.startedAt;
  }
  if (seguidas < limite || !ultimaFalha) return { permite: true, seguidas, motivo: 'normal' };
  const proxima = new Date(+ultimaFalha + descansoMs);
  return +agora >= +proxima ? { permite: true, seguidas, motivo: 'sonda' } : { permite: false, seguidas, motivo: 'freado', proxima };
}
