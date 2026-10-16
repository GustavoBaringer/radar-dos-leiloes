import * as fs from 'node:fs';
import { pool } from '../src/core/db.js';
import { LOT_SITE_HOST_SQL, upsertLots, ensureSources } from '../src/core/repo.js';
import { getConnector } from '../src/connectors/index.js';

interface Target {
  domain: string;
  sourceId: string;
  single: boolean;
  tenant?: string;
  plat: string;
}

const collectables: Target[] = [
  { domain: 'mcleilao.com.br', sourceId: 'mcleilao', single: false, plat: 'MC Leilão' },
  { domain: 'leiloesbrasil.com.br', sourceId: 'leiloesbrasilpublic', single: false, plat: 'Roisoft / Leilões Brasil' },
  { domain: 'leiloesjudiciaisgo.com.br', sourceId: 'vlance', single: true, tenant: 'alvaroleiloes.com.br', plat: 'vlance' },
  { domain: 'leiloescentrooeste.com.br', sourceId: 'vlance', single: true, tenant: 'leiloescentrooeste.com.br', plat: 'vlance' },
  { domain: 'marcelolimaleiloes.com.br', sourceId: 'vlance', single: true, tenant: 'marcelolimaleiloes.com.br', plat: 'vlance' },
  { domain: 'buenoleiloes.com.br', sourceId: 'suporteleiloes', single: true, tenant: 'buenoleiloes.com.br', plat: 'suporte-leiloes' },
  { domain: 'tezaleiloes.com.br', sourceId: 'suaplataforma', single: true, tenant: 'tezaleiloes.com.br', plat: 'sua-plataforma' },
  { domain: 'gfleiloes.com.br', sourceId: 'suaplataforma', single: true, tenant: 'gfleiloes.com.br', plat: 'sua-plataforma' },
  { domain: 'lanceja.com.br', sourceId: 'soleon', single: true, tenant: 'lanceja.com.br', plat: 'soleon' },
  { domain: 'arrematabem.com.br', sourceId: 'htmlagenda', single: true, tenant: 'arrematabem.com.br', plat: 'html-agenda' },
  { domain: 'duxleiloes.com.br', sourceId: 'htmlagenda', single: true, tenant: 'duxleiloes.com.br', plat: 'html-agenda' },
  { domain: 'vzleiloes.com.br', sourceId: 'htmlagenda', single: true, tenant: 'vzleiloes.com.br', plat: 'html-agenda' },
  { domain: 'hammer.lel.br', sourceId: 'casadeleiloes', single: true, tenant: 'hammer.lel.br', plat: 'casa-de-leiloes' },
  { domain: 'oaleiloes.com.br', sourceId: 'leiloar', single: true, tenant: 'oaleiloes.com.br', plat: 'leiloar' },
  { domain: 'jussiaraleiloes.com', sourceId: 'leiloar', single: true, tenant: 'jussiaraleiloes.com', plat: 'leiloar' },
  { domain: 'prosperarleiloes.com.br', sourceId: 'leiloar', single: true, tenant: 'prosperarleiloes.com.br', plat: 'leiloar' },
  { domain: 'arremateleiloesjudiciais.com.br', sourceId: 'leiloar', single: true, tenant: 'maiorofertaleiloes.com.br', plat: 'leiloar' },
  { domain: 'leiloesfederal.com.br', sourceId: 'leiloar', single: true, tenant: 'leiloesfederal.com.br', plat: 'leiloar' },
  { domain: 'alfaleiloes.com', sourceId: 'alfaleiloes', single: false, plat: 'alfaleiloes' }
];

const inactives = [
  { domain: 'lkleiloes.com.br', plat: 'Nenhuma', motivo: 'HTTP 410 Gone (servidor desativado pelo leiloeiro)' },
  { domain: 'rjleiloes.com.br', plat: 'Nenhuma', motivo: 'HTTP 410 Gone (servidor desativado pelo leiloeiro)' },
  { domain: 'bernardinileiloes.com.br', plat: 'Nenhuma', motivo: 'Domínio expirado / à venda (abovedomains.com)' },
  { domain: 'federalleiloes.com', plat: 'Nenhuma', motivo: 'Erro DNS ENOTFOUND (substituído por leiloesfederal.com.br)' },
  { domain: 'mgrleiloes.com.br', plat: 'Superbid', motivo: 'Vitrine parceira já consolidada via conector superbid' },
  { domain: 'innovaleiloes.com.br', plat: 'leiloar', motivo: 'Certificado SSL expirado desde 2023 no HTTPS' },
  { domain: 'teleselimaleiloes.com.br', plat: 'Roisoft', motivo: 'Plataforma Roisoft individual (sem conector multi-tenant)' },
  { domain: 'liraleiloes.com.br', plat: 'Roisoft', motivo: 'Plataforma Roisoft individual (sem conector multi-tenant)' },
  { domain: 'caiapoleiloes.com.br', plat: 'Roisoft', motivo: 'Plataforma Roisoft individual (sem conector multi-tenant)' }
];

async function run() {
  await ensureSources();

  // Pré-cadastra no discovered_sites para os multi-tenants localizarem a população elegível
  for (const t of collectables) {
    if (t.single) {
      await pool.query(
        `INSERT INTO discovered_sites (domain, platform, connector_id, http_status, has_lots)
         VALUES ($1, $2, $3, 200, true)
         ON CONFLICT (domain) DO UPDATE SET platform=$2, connector_id=$3, http_status=200, has_lots=true`,
        [t.tenant ?? t.domain, t.plat, t.sourceId]
      );
    }
  }

  console.log('\n=== INICIANDO COLETA PERSISTENTE (BATCH 2) ===\n');

  const reportItems: any[] = [];

  for (let i = 0; i < collectables.length; i++) {
    const t = collectables[i];
    console.log(`[${i + 1}/${collectables.length}] Processando ${t.domain} via ${t.sourceId}...`);

    const qBefore = await pool.query(`SELECT count(*)::int as c FROM lots WHERE ${LOT_SITE_HOST_SQL} = $1`, [t.domain]);
    const beforeCount = qBefore.rows[0]?.c ?? 0;
    const conn = getConnector(t.sourceId);

    if (!conn) {
      const item = {
        domain: t.domain,
        ganho: 0,
        antes: beforeCount,
        depois: beforeCount,
        lidos: 0,
        mapeados: 0,
        gravados: 0,
        novos: 0,
        descartados: 0,
        plat: t.plat,
        sourceId: t.sourceId,
        situacao: `Conector ${t.sourceId} não registrado`
      };
      reportItems.push(item);
      continue;
    }

    try {
      const tenantArg = t.tenant ?? t.domain;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout de coleta (30s)')), 30000)
      );
      const collectPromise = t.single
        ? conn.collect({ limit: 400, tenant: tenantArg })
        : conn.collect({ limit: 400 });

      const res: any = await Promise.race([collectPromise, timeoutPromise]);

      let upserted = 0;
      let novos = 0;
      if (res.lots && res.lots.length > 0) {
        const up = await upsertLots(res.lots);
        upserted = up.upserted;
        novos = up.novos.length;
      }

      const qAfter = await pool.query(`SELECT count(*)::int as c FROM lots WHERE ${LOT_SITE_HOST_SQL} = $1`, [t.domain]);
      const afterCount = qAfter.rows[0]?.c ?? 0;
      const gain = afterCount - beforeCount;

      const item = {
        domain: t.domain,
        ganho: gain,
        antes: beforeCount,
        depois: afterCount,
        lidos: res.fetched || 0,
        mapeados: res.lots?.length || 0,
        gravados: upserted,
        novos,
        descartados: res.skipped || 0,
        plat: t.plat,
        sourceId: t.sourceId,
        situacao: 'Sucesso na coleta persistente'
      };
      reportItems.push(item);
      console.log(`  -> ${t.domain}: lidos=${item.lidos} mapeados=${item.mapeados} gravados=${item.gravados} novos=+${novos} antes=${beforeCount} depois=${afterCount} ganho=+${gain}`);
    } catch (err: any) {
      const qAfter = await pool.query(`SELECT count(*)::int as c FROM lots WHERE ${LOT_SITE_HOST_SQL} = $1`, [t.domain]);
      const afterCount = qAfter.rows[0]?.c ?? 0;
      const item = {
        domain: t.domain,
        ganho: afterCount - beforeCount,
        antes: beforeCount,
        depois: afterCount,
        lidos: 0,
        mapeados: 0,
        gravados: 0,
        novos: 0,
        descartados: 0,
        plat: t.plat,
        sourceId: t.sourceId,
        situacao: `Falha na coleta: ${err.message}`
      };
      reportItems.push(item);
      console.log(`  -> ${t.domain} ERRO: ${err.message}`);
    }
  }

  for (const i of inactives) {
    const qBefore = await pool.query(`SELECT count(*)::int as c FROM lots WHERE ${LOT_SITE_HOST_SQL} = $1`, [i.domain]);
    const count = qBefore.rows[0]?.c ?? 0;
    const item = {
      domain: i.domain,
      ganho: 0,
      antes: count,
      depois: count,
      lidos: 0,
      mapeados: 0,
      gravados: 0,
      novos: 0,
      descartados: 0,
      plat: i.plat,
      sourceId: null,
      situacao: i.motivo
    };
    reportItems.push(item);
  }

  fs.writeFileSync('scripts/relatorio_batch2.json', JSON.stringify(reportItems, null, 2));

  console.log('\n=== RESULTADO FINAL FORMATADO EM LISTA ===\n');
  for (const r of reportItems) {
    console.log(`${r.domain}`);
    console.log(`- ganhos: +${r.ganho}`);
    console.log(`- diferenca: Antes ${r.antes} -> Depois ${r.depois}`);
    console.log(`- metricas: Lidos: ${r.lidos} | Mapeados: ${r.mapeados} | Gravados: ${r.gravados} | Novos: ${r.novos} | Descartados: ${r.descartados}`);
    console.log(`- plataforma: ${r.plat}${r.sourceId ? ' (' + r.sourceId + ')' : ''}`);
    console.log(`- situacao: ${r.situacao}\n`);
  }

  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
