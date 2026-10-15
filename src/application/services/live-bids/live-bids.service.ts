import { Inject, Injectable } from '@nestjs/common';
import { intervaloMs } from '../../../domain/lots/live-bids.js';
import type { LoteQuente, Leitura } from '../../../domain/lots/live-bids.js';

export const LIVE_BIDS_DEPENDENCIES = Symbol('LIVE_BIDS_DEPENDENCIES');

export interface LiveBidsDependencies {
  lotesQuentes(fontes: string[]): Promise<LoteQuente[]>;
  leitores: Record<string, (lote: LoteQuente) => Promise<Leitura | null>>;
  registrarLeituraAoVivo(id: number, lance: number | null, fim?: Date | null): Promise<unknown>;
  publicar(payload: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

@Injectable()
export class LiveBidsService {
  private readonly proximaLeitura = new Map<number, number>();
  private readonly semCanalLotes = new Map<number, string>();
  private lendo = false;

  constructor(@Inject(LIVE_BIDS_DEPENDENCIES) private readonly deps: LiveBidsDependencies) {}

  semCanal(fonte: string): boolean { return [...this.semCanalLotes.values()].includes(fonte); }
  temLeitor(fonte: string): boolean { return fonte in this.deps.leitores; }

  async ciclo(): Promise<void> {
    if (this.lendo) return;
    this.lendo = true;
    try {
      const agora = Date.now();
      const lotes = await this.deps.lotesQuentes(Object.keys(this.deps.leitores));
      const vivos = new Set(lotes.map((l) => l.id));
      for (const id of this.proximaLeitura.keys()) if (!vivos.has(id)) this.proximaLeitura.delete(id);
      for (const id of this.semCanalLotes.keys()) if (!vivos.has(id)) this.semCanalLotes.delete(id);

      const mudancas: unknown[] = [];
      let lidos = 0;
      for (const lote of lotes) {
        const intervalo = intervaloMs(lote.fim, agora);
        if (intervalo == null || (this.proximaLeitura.get(lote.id) ?? 0) > agora) continue;
        this.proximaLeitura.set(lote.id, agora + intervalo * (1 + Math.random() * 0.2));
        let leitura: Leitura | null = null;
        try { leitura = await this.deps.leitores[lote.sourceId](lote); }
        catch (e: any) { console.error(`[aovivo] ${lote.sourceId} ${lote.externalId}:`, e.message); }
        lidos++;
        if (!leitura) { this.semCanalLotes.set(lote.id, lote.sourceId); continue; }
        this.semCanalLotes.delete(lote.id);
        const mudanca = await this.deps.registrarLeituraAoVivo(lote.id, leitura.lance, leitura.fim);
        if (mudanca) mudancas.push(mudanca);
        await this.deps.sleep(150);
      }
      if (mudancas.length) await this.deps.publicar(JSON.stringify({ type: 'bids', changes: mudancas }));
      if (lidos) console.log(`[aovivo] ${lidos} lidos · ${mudancas.length} lances novos · ${this.semCanalLotes.size} sem canal`);
    } catch (e: any) { console.error('[aovivo] falhou:', e.message); }
    finally { this.lendo = false; }
  }
}
