import { avaliarAlertas } from './alerts.js';
import { enviarPush, enviarEmail } from './notificar.js';

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
}

export async function processarAposColeta(
  novos: number[],
  publicar?: (payload: unknown) => Promise<unknown>,
): Promise<ResultadoPosColeta> {
  const vazio = { disparos: 0, push: 0, emails: 0, pendentesEmail: 0 };
  if (!novos.length) return vazio;

  try {
    const disparos = await avaliarAlertas(novos);
    if (!disparos.length) return vazio;

    if (publicar) await publicar({ type: 'alertas', disparos });
    const push = await enviarPush(disparos);
    const email = await enviarEmail(disparos);
    return { disparos: disparos.length, push, emails: email.enviados, pendentesEmail: email.pendentes };
  } catch (err: any) {
    // Falha de aviso não derruba a coleta: o lote já está gravado e o aviso
    // pode ser reprocessado; o inverso não é verdade.
    console.error('[alerta] falhou:', err?.message);
    return vazio;
  }
}
