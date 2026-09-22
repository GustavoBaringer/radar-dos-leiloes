import { query } from './db.js';

/**
 * Freio de coleta: para de bater numa fonte que já disse não.
 *
 * MEDIDO em 22/09: o superbid recebeu 1.218 coletas em 7 dias, 200 delas nas
 * últimas 48h, TODAS devolvendo HTTP 403. Não é uma fonte instável que às vezes
 * falha — é um WAF que nos recusa desde 19/09, e a cada tentativa nós
 * confirmamos para ele que o padrão de acesso continua. Bater 174 vezes por dia
 * numa porta trancada não abre a porta; alimenta o bloqueio.
 *
 * O freio é meio-aberto (half-open), não um desligamento: depois do descanso
 * UMA sonda passa. Se a fonte voltar, a sonda acerta e o freio solta sozinho —
 * ninguém precisa lembrar de religar. Se continuar recusando, a sonda falha e o
 * descanso recomeça. São 4 sondas por dia contra 174 tentativas.
 *
 * `decideFreio` é pura de propósito: a decisão tem três casos de borda (fonte
 * nova sem histórico, execução que nunca terminou, descanso vencido) e um
 * portão que precisasse de rede para exercitá-los não exercitaria nenhum.
 */

/** Falhas seguidas que fecham o freio. */
export const FALHAS_PARA_FREAR = 5;
/** Quanto tempo o freio segura antes de deixar passar a sonda. */
export const DESCANSO_FREIO_H = 6;

export interface Tentativa {
  /** `null` é execução que começou e nunca terminou — o worker morreu no meio. */
  ok: boolean | null;
  startedAt: Date;
}

export interface Veredito {
  permite: boolean;
  /** Falhas seguidas contadas a partir da mais recente. */
  seguidas: number;
  /** `sonda` é a passagem única depois do descanso: a fonte pode ter voltado. */
  motivo: 'normal' | 'sonda' | 'freado';
  /** Quando a próxima sonda passa. Só existe quando o freio está fechado. */
  proxima?: Date;
}

export function decideFreio(
  recentes: Tentativa[],
  agora: Date = new Date(),
  cfg: { falhas?: number; descansoH?: number } = {},
): Veredito {
  const limite = cfg.falhas ?? FALHAS_PARA_FREAR;
  const descansoMs = (cfg.descansoH ?? DESCANSO_FREIO_H) * 3_600_000;

  // Execução sem desfecho não conta como falha NEM zera a contagem: ela não
  // carrega informação sobre a fonte, só sobre nós. Contá-la como falha frearia
  // uma fonte saudável depois de cinco reinícios do worker; deixá-la zerar a
  // contagem apagaria o bloqueio a cada reinício, que é exatamente quando ele
  // mais precisa valer.
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
  return +agora >= +proxima
    ? { permite: true, seguidas, motivo: 'sonda' }
    : { permite: false, seguidas, motivo: 'freado', proxima };
}

/** Lê o histórico da fonte e decide. Só as últimas execuções: a contagem é de falhas SEGUIDAS. */
export async function consultaFreio(sourceId: string): Promise<Veredito> {
  const linhas = await query<{ ok: boolean | null; started_at: Date }>(
    `SELECT ok, started_at FROM collection_runs
      WHERE source_id = $1 AND job IN ('collect','collect:cli')
      ORDER BY started_at DESC LIMIT $2`,
    [sourceId, FALHAS_PARA_FREAR * 4],
  );
  return decideFreio(linhas.map((l) => ({ ok: l.ok, startedAt: new Date(l.started_at) })));
}

/** Quem está freado agora — para a tela de cobertura e para o portão de saúde. */
export async function fontesFreadas(): Promise<Array<{ sourceId: string; seguidas: number; proxima?: Date }>> {
  const ids = await query<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM collection_runs WHERE job IN ('collect','collect:cli')`,
  );
  const freadas = [];
  for (const { source_id } of ids) {
    const v = await consultaFreio(source_id);
    if (!v.permite) freadas.push({ sourceId: source_id, seguidas: v.seguidas, proxima: v.proxima });
  }
  return freadas;
}
