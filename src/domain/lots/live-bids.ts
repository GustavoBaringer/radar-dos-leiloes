export interface LoteQuente {
  id: number;
  sourceId: string;
  externalId: string;
  lotUrl: string | null;
  leilaoId: string | null;
  currentBid: number | null;
  fim: Date;
}

export interface Leitura {
  lance: number | null;
  /** Fechamento prorrogado (lance no fim estende o prazo). Só quando a fonte publica. */
  fim?: Date | null;
}

export const EXCECOES_VLANCE: Record<string, string> = {
  leiloesjudiciaismgnorte: 'leiloesjudiciais-mgnorte',
  joserodovalholeiloes: 'leiloesjudiciais-mgnorte',
  rigolonleiloes: 'rigolon-leiloes',
  mariafixerleiloes: 'mariafixer-leiloes',
  planaltoleiloes: 'planalto-leiloes',
  nortenordesteleiloes: 'cearaleiloes',
  franciscofreitasleiloes: 'cearaleiloes',
  doleiloes: 'danieloliveiraleiloes',
  jrleiloes: 'leiloesjudiciaissul',
  leiloeszanoni: 'leiloesjudiciaissc',
  superaleiloes: 'supera-leiloes',
};

export function bancoPeloDominio(host: string): string {
  const partes = host.toLowerCase().split('.');
  const nome = partes[0] === 'www' || partes[0] === 'www3' ? partes[1] : partes[0];
  return EXCECOES_VLANCE[nome] ?? nome;
}

export function fimDoVlance(s: unknown, fusoHoras: number): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  return new Date(new Date(`${m[1]}T${m[2]}-03:00`).getTime() + fusoHoras * 3_600_000);
}

/** Quanto esperar até ler de novo, pelo tempo que falta para fechar. `null` = fora da janela. */
export function intervaloMs(fim: Date, agora = Date.now()): number | null {
  const falta = fim.getTime() - agora;
  if (falta > 60 * 60_000) return null;
  // Depois do prazo o lote ainda pode ter sido prorrogado: lê mais um pouco antes de soltar.
  if (falta < -3 * 60_000) return null;
  if (falta > 15 * 60_000) return 5 * 60_000;
  if (falta > 5 * 60_000) return 60_000;
  return 15_000;
}
