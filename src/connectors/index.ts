import type { Connector } from './types.js';
import { superbid } from './superbid.js';
import { copart } from './copart.js';
import { leilo } from './leilo.js';
import { kuss } from './kuss.js';
import { freitas } from './freitas.js';
import { caixa } from './caixa.js';
import { soleon } from './soleon.js';
import { vlance } from './vlance.js';
import { leilaopro } from './leilaopro.js';
import { suaplataforma } from './suaplataforma.js';
import { suporteleiloes } from './suporteleiloes.js';
import { bomvalor } from './bomvalor.js';
import { leiloar } from './leiloar.js';
import { leiloesbr } from './leiloesbr.js';
import { leilotech } from './leilotech.js';
import { bomvalormercado } from './bomvalormercado.js';
import { sishp } from './sishp.js';
import { leilovia } from './leilovia.js';
import { megaleiloes, grupolance } from './megaleiloes.js';

export const connectors: Connector[] = [superbid, copart, leilo, kuss, freitas, caixa, soleon, vlance, leilaopro, suaplataforma, suporteleiloes, bomvalor, leiloar, leiloesbr, leilotech, bomvalormercado, sishp, leilovia, megaleiloes, grupolance];

export function getConnector(id: string): Connector | undefined {
  return connectors.find((c) => c.def.id === id);
}
