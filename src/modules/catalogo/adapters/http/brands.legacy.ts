export const BRANDS_SQL =
  'SELECT brand, COUNT(*)::int AS count FROM lots WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC';

export function registerBrandsRoute(
  app: any,
  query: (sql: string) => Promise<Array<{ brand: string; count: number }>>,
  withReadResources: (handler: (req: any, reply: any) => unknown | Promise<unknown>) => (req: any, reply: any) => unknown,
  brandList: readonly unknown[],
): void {
  app.get('/api/brands', withReadResources(async () => {
    const rows = await query(BRANDS_SQL);
    return { known: brandList, present: rows };
  }));
}
