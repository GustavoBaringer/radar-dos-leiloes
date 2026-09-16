import type { CanonicalLot, SourceDef } from '../core/types.js';

export interface CollectResult {
  lots: CanonicalLot[];
  fetched: number;
  skipped: number;
  httpStatus?: number;
  note?: string;
}

export interface Connector {
  def: SourceDef;
  /** Coleta um bloco de lotes. `limit` existe para a POC não varrer o estoque inteiro. */
  collect(opts: { limit: number; keywords?: string[]; assetTypes?: string[] }): Promise<CollectResult>;
  /** Atualiza lance/status de um lote quente. Opcional: nem toda fonte permite. */
  refresh?(externalId: string): Promise<{ currentBid?: number | null; status?: string } | null>;
}
