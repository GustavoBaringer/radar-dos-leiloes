import { avaliarAlertas } from './alerts.js';
import { aplicarLimitesDeEntrega, enviarPush, enviarEmail, type LimitesEntrega } from './notificar.js';

/**
 * O que acontece DEPOIS de gravar lotes, seja qual for o caminho de coleta.
 *
 * Existe porque o motor de alertas vivia só dentro do worker: coleta disparada
 * por `scripts/collect.ts` gravava os lotes e não avisava ninguém. O sintoma foi
 * cruel — o alerta estava certo, o lote estava no banco, o predicado casava, e
 * mesmo assim nada chegava. Um único ponto de saída impede que os dois caminhos
 * divirjam de novo.
 */
export interface ResultadoPosColeta {
  disparos: number;
  push: number;
  emails: number;
  pendentesEmail: number;
  /** Disparos casados, com canal adiado pelo teto de entrega. O hit continua gravado. */
  adiados?: number;
}

export async function processarAposColeta(
  novos: number[],
  publicar?: (payload: unknown) => Promise<unknown>,
  limites?: LimitesEntrega,
): Promise<ResultadoPosColeta> {
  const vazio = { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 };
  if (!novos.length) return vazio;

  try {
    const disparos = await avaliarAlertas(novos);
    if (!disparos.length) return vazio;

    if (publicar) await publicar({ type: 'alertas', disparos });
    // O hit já está no banco antes daqui: o teto decide só o que sai por push e
    // e-mail agora. Quem chama sem limite entrega cada lote novo como aviso.
    const janela = limites
      ? await aplicarLimitesDeEntrega(disparos, limites)
      : { disparos, adiados: 0 };
    const push = await enviarPush(janela.disparos);
    const email = await enviarEmail(janela.disparos);
    return {
      disparos: disparos.length,
      push,
      emails: email.enviados,
      pendentesEmail: email.pendentes,
      adiados: janela.adiados,
    };
  } catch (err: any) {
    // Falha de aviso não derruba a coleta: o lote já está gravado e o aviso
    // pode ser reprocessado; o inverso não é verdade.
    console.error('[alerta] falhou:', err?.message);
    return vazio;
  }
}