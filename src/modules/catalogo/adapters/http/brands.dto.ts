/** Envelope estático de saída de `/api/brands` — mesmo contrato do adaptador legado. */
export interface BrandCountDto {
  readonly brand: string;
  readonly count: number;
}

export interface BrandsResponseDto {
  readonly known: readonly string[];
  readonly present: readonly BrandCountDto[];
}
