import type { CanonicalLot } from './types.js';
import { prepareLotForPersistence, type PrepareLotResult } from './prepare-lot.js';

/** Domain entity owning a lot's stable source identity and preparation entrypoint. */
export class Lot {
  constructor(readonly canonicalLot: CanonicalLot) {
    if (
      !canonicalLot ||
      typeof canonicalLot.sourceId !== 'string' || !canonicalLot.sourceId.trim() ||
      typeof canonicalLot.externalId !== 'string' || !canonicalLot.externalId.trim()
    ) {
      throw new TypeError('Identidade do lote inválida.');
    }
  }

  prepare(): PrepareLotResult {
    return prepareLotForPersistence(this.canonicalLot);
  }
}
