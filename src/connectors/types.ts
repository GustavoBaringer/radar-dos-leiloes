import type { CanonicalLot, SourceDef } from '../core/types.js';
import type { TenantObserver } from '../core/tenant-attempts.js';

export interface CollectResult {
  lots: CanonicalLot[];
  fetched: number;
  skipped: number;
  httpStatus?: number;
  note?: string;
}

export interface CollectOptions {
  limit: number;
  keywords?: string[];
  assetTypes?: string[];
  observer?: TenantObserver;
  /**
   * Single-tenant (Step4): coleta explícita de UM domínio, normalizado como a
   * população (minúsculas, sem www nem ponto final). Undefined = comportamento
   * de sempre. O runtime (worker/CLI) não popula este campo; quem chama é
   * `collectTenant` em `src/core/single-tenant.ts`, atrás do portão do Step5.
   */
  tenant?: string;
}

export interface Connector {
  def: SourceDef;
  /** Coleta um bloco de lotes. `limit` existe para a POC não varrer o estoque inteiro. */
  collect(opts: CollectOptions): Promise<CollectResult>;
  /** Atualiza lance/status de um lote quente. Opcional: nem toda fonte permite. */
  refresh?(externalId: string): Promise<{ currentBid?: number | null; status?: string } | null>;
}
