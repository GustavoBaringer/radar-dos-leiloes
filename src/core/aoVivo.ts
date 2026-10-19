import { bancoPeloDominio, fimDoVlance, intervaloMs } from '../domain/lots/live-bids.js';
import { LEITORES } from '../infra/live-bids/live-bids.readers.js';
import { lotesQuentes } from '../infra/database/repositories/live-bids.repository.js';
import type { LoteQuente, Leitura } from '../domain/lots/live-bids.js';
export { bancoPeloDominio, fimDoVlance, intervaloMs } from '../domain/lots/live-bids.js';
export type { LoteQuente, Leitura } from '../domain/lots/live-bids.js';

// Lance ao vivo lido do Firebase público que o próprio site usa: ~300 bytes por
// lote quente em vez de recoletar o catálogo inteiro. Só o VALOR é lido — o nó
// de lance traz nome e apelido de quem deu o lance, e isso não entra na base.

export { LEITORES };

/* ------------------------------------------------------------------ */
/* Cadência                                                            */
/* ------------------------------------------------------------------ */

/** Quanto esperar até ler de novo, pelo tempo que falta para fechar. `null` = fora da janela. */
export { lotesQuentes };
