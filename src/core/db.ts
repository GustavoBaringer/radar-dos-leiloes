import pg from 'pg';

// numeric do Postgres chega como string no driver; o app trabalha com number.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://leilao:leilao@127.0.0.1:5433/leilao',
  max: 10,
});

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}
