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

export const connectors: Connector[] = [superbid, copart, leilo, kuss, freitas, caixa, soleon, vlance, leilaopro];

export function getConnector(id: string): Connector | undefined {
  return connectors.find((c) => c.def.id === id);
}
