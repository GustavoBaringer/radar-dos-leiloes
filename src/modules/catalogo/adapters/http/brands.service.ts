import { BRAND_LIST } from '../../../../core/normalize.js';
import { BRANDS_SQL } from './brands.legacy.js';
import type { BrandsResponseDto } from './brands.dto.js';

/** Token de injeção da consulta central do catálogo (mesmo `query` do host). */
export const CORE_BRANDS_QUERY = 'CORE_BRANDS_QUERY';

export type BrandsQuery = (sql: string) => Promise<Array<{ brand: string; count: number }>>;

/** Reusa o SQL e a lista de marcas do caminho legado: um contrato, duas cascas. */
export class BrandsService {
  constructor(private readonly query: BrandsQuery) {}

  async list(): Promise<BrandsResponseDto> {
    const present = await this.query(BRANDS_SQL);
    return { known: BRAND_LIST, present };
  }
}
