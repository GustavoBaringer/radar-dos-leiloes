import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const safe = (url, name) => {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55433' || parsed.username !== 'radar_test' || parsed.password !== 'radar_test_local' || parsed.pathname !== `/${name}`) {
    throw new Error(`Refusing non-fixture database URL for ${name}`);
  }
  return url;
};
const legacy = safe(process.env.LEGACY_DATABASE_URL ?? 'postgres://radar_test:radar_test_local@127.0.0.1:55433/radar_legacy', 'radar_legacy');
const prisma = safe(process.env.DATABASE_URL ?? 'postgres://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma', 'radar_prisma');
const pool = (connectionString) => new Pool({ connectionString });
const legacyPool = pool(legacy);
const prismaPool = pool(prisma);

// Replay the historical DDL in the isolated comparison database, excluding the
// user bootstrap/backfill DML from 011 (empty schema has no rows to backfill).
try {
  for (let i = 1; i <= 16; i++) {
    const filename = `db/${String(i).padStart(3, '0')}_${[
      'schema','sanidade','tipos','leiloeiros','alertas','fenaju','tipo_imovel','cidade','titulo','espera','usuarios','encerramento','verificacao','favoritos','cadastros','tenant_collection_attempts',
    ][i - 1]}.sql`;
    let sql = await readFile(filename, 'utf8');
    if (i === 11) {
      sql = sql.replace(/INSERT INTO users[\s\S]*?;\s*/g, '');
      sql = sql.replace(/UPDATE (?:alerts|saved_searches|push_subscriptions)[\s\S]*?;\s*/g, '');
    }
    await legacyPool.query(sql);
  }

  const catalog = async (db) => {
    const { rows } = await db.query(`
      SELECT category, object_name, definition FROM (
        SELECT 'extension' category, extname object_name, extversion definition
          FROM pg_extension WHERE extname IN ('pg_trgm','unaccent')
        UNION ALL
        SELECT 'table', c.relname, '' FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations'
        UNION ALL
        SELECT 'column', c.relname||'.'||a.attname, format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
          FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
          WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND c.relname <> '_prisma_migrations'
        UNION ALL
        SELECT 'constraint', c.conrelid::regclass::text||'.'||c.conname, pg_get_constraintdef(c.oid)
          FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
          WHERE n.nspname='public' AND c.conrelid::regclass::text <> '"_prisma_migrations"'
        UNION ALL
        SELECT 'index', t.relname||'.'||x.relname, pg_get_indexdef(i.indexrelid)
          FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname <> '_prisma_migrations'
        UNION ALL
        SELECT 'function', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', pg_get_functiondef(p.oid)
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      ) objects ORDER BY category, object_name, definition`);
    return rows.map((r) => `${r.category}|${r.object_name}|${r.definition}`);
  };
  const [left, right] = await Promise.all([catalog(legacyPool), catalog(prismaPool)]);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    const only = (a, b) => a.filter((x) => !b.includes(x));
    console.error(JSON.stringify({ onlyLegacy: only(left, right), onlyPrisma: only(right, left) }, null, 2));
    throw new Error('Schema catalog drift detected');
  }
  console.log(`Schema parity passed (${left.length} catalog entries); only _prisma_migrations is excluded.`);
} finally {
  await Promise.all([legacyPool.end(), prismaPool.end()]);
}
