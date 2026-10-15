import { Inject, Injectable } from '@nestjs/common';
import type { LoteParaVerificar, Resultado, Verificador } from '../../../domain/lots/verification.js';
import type { LotClosureRepositoryPort } from '../../../infra/database/repositories/lot-closure.repository.js';
import { LOT_CLOSURE_REPOSITORY, LOT_VERIFIERS } from '../../modules/closure/closure.tokens.js';

export interface LotClosureDependencies {
  repository: LotClosureRepositoryPort;
  verifiers: Record<string, Verificador>;
}

const AUSENCIA_LIGADA = process.env.ENCERRAR_POR_AUSENCIA === '1';
const CICLOS_PARA_AUSENCIA = Number(process.env.ENCERRAR_APOS_CICLOS ?? 3);
const LIMITE_DE_VARREDURA = 1000;

export interface ResultadoEncerramento { porPrazo: number; porAusencia: number }

@Injectable()
export class LotClosureService {
  constructor(
    @Inject(LOT_CLOSURE_REPOSITORY) private readonly repository: LotClosureRepositoryPort,
    @Inject(LOT_VERIFIERS) private readonly verifiers: Record<string, Verificador>,
  ) {}

  async encerrarLotes(): Promise<ResultadoEncerramento> {
    return {
      porPrazo: await this.repository.encerrarPorPrazo(),
      porAusencia: AUSENCIA_LIGADA ? await this.repository.encerrarPorAusencia(CICLOS_PARA_AUSENCIA, LIMITE_DE_VARREDURA) : 0,
    };
  }

  async verificarCandidatos(teto = Number(process.env.VERIFICAR_POR_CICLO ?? 300)) {
    const fontes = Object.keys(this.verifiers);
    if (!fontes.length) return { verificados: 0, encerrados: 0, vivos: 0, indeterminados: 0 };
    const candidatos = await this.repository.candidatos(fontes, LIMITE_DE_VARREDURA, teto);
    if (!candidatos.length) return { verificados: 0, encerrados: 0, vivos: 0, indeterminados: 0 };

    const porHost = new Map<string, { fonte: string; lotes: LoteParaVerificar[] }>();
    for (const candidate of candidatos) {
      let host = '';
      try { host = new URL(candidate.lot_url ?? '').host; }
      catch { host = `(sem-url)-${candidate.source_id}`; }
      const group = porHost.get(host) ?? { fonte: candidate.source_id, lotes: [] };
      group.lotes.push({ id: Number(candidate.id), externalId: candidate.external_id, lotUrl: candidate.lot_url, categoria: candidate.source_category });
      porHost.set(host, group);
    }

    const vereditos: Array<{ id: number; veredito: Resultado['veredito']; sinal: string; fimUtc?: string | null }> = [];
    await Promise.all([...porHost.entries()].map(async ([host, { fonte, lotes }]) => {
      const verifier = this.verifiers[fonte];
      if (!verifier) return;
      try {
        const results = await verifier.verificar(host, lotes);
        for (const [id, result] of results) vereditos.push({ id, ...result });
      } catch (error: any) {
        for (const lot of lotes) vereditos.push({ id: lot.id, veredito: 'indeterminado', sinal: String(error.message).slice(0, 50) });
      }
    }));

    const mortos = vereditos.filter((v) => v.veredito === 'encerrado' || v.veredito === 'sumiu');
    const vivos = vereditos.filter((v) => v.veredito === 'aberto' || v.veredito === 'agendado');
    const cegos = vereditos.filter((v) => v.veredito === 'indeterminado');
    await this.repository.aplicarVereditos(mortos, vivos, cegos);
    const comPrazo = vereditos.filter((v): v is typeof v & { fimUtc: string } => Boolean(v.fimUtc));
    await this.repository.corrigirPrazo(comPrazo);
    return { verificados: vereditos.length, encerrados: mortos.length, vivos: vivos.length, indeterminados: cegos.length };
  }
}

export const ausenciaLigada = () => AUSENCIA_LIGADA;
