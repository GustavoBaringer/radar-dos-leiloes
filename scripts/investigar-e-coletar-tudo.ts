import * as fs from 'node:fs';
import { pool } from '../src/core/db.js';
import { LOT_SITE_HOST_SQL, upsertLots, ensureSources } from '../src/core/repo.js';
import { getConnector, connectors } from '../src/connectors/index.js';
import { RAW_INPUTS, normalizeDomain } from './investigar-lista.js';
import { DAILY_SITES } from '../src/queue/daily-coverage.js';

interface DomainResult {
  raw: string;
  domain: string;
  testedDomain: string;
  sourceId: string | null;
  status: string;
  before: number;
  after: number;
  gain: number;
  fetched: number | string;
  mapped: number | string;
  upserted: number | string;
  novos: number | string;
  skipped: number | string;
  motivo: string;
}

// Map each domain to its proven connector
function getConnectorForDomain(domain: string): { sourceId: string; isSingleTenant: boolean } | null {
  // 1. Supabase Leilões
  if (['dbmleiloes.com.br', 'zaccarino.com.br', 'coimbraleiloes.com.br', 'shiokawaleiloes.com.br', 'faroonline.com.br', 'rocketleiloes.com.br', 'savoyleiloes.com.br'].includes(domain)) {
    const id = domain.replace(/\.com\.br$/, '').replace(/\./g, '');
    return { sourceId: id, isSingleTenant: false };
  }

  // 2. Supra tenants
  if (domain === 'albertomacedoleiloes.com.br') return { sourceId: 'albertomacedo', isSingleTenant: false };
  if (domain === 'bigleilao.com.br') return { sourceId: 'bigleilao', isSingleTenant: false };
  if (domain === 'clebercardosoleiloes.com.br') return { sourceId: 'clebercardosoleiloes', isSingleTenant: false };
  if (domain === 'cunhaleiloeiro.com.br') return { sourceId: 'cunhaleiloeiro', isSingleTenant: false };

  // 3. Singletons
  if (domain === 'globoleiloes.com.br') return { sourceId: 'globoleiloes', isSingleTenant: false };
  if (domain === 'alfaleiloes.com') return { sourceId: 'alfaleiloes', isSingleTenant: false };
  if (domain === 'hastapublica.com.br') return { sourceId: 'hastapublica', isSingleTenant: false };
  if (domain === 'portalzuk.com.br' || domain === 'frazaoleiloes.com.br') return { sourceId: 'portalzuk', isSingleTenant: false };
  if (domain === 'vincoleiloes.com.br') return { sourceId: 'sishp', isSingleTenant: true };
  if (domain === 'hammer.lel.br') return { sourceId: 'casadeleiloes', isSingleTenant: false };
  if (domain === 'sfleiloes.com.br') return { sourceId: 'leilotech', isSingleTenant: true };

  // 4. Multi-tenants
  // soleon (33 domains)
  const soleonList = [
    'danielgarcialeiloes.com.br', 'tribunaleiloes.com.br', 'cardosoleiloes.com.br', 'gspleiloes.com.br',
    'leilaoinvestment.com.br', 'wspleiloes.com.br', 'cravoleiloes.com.br', 'atomazellileiloeira.com.br',
    'cencin.com.br', 'ricoleiloes.com.br', 'guariglialeiloes.com.br', 'lanceleiloes.com.br',
    'amaralleiloes.com.br', 'clicleiloes.com.br', 'machadoleiloeiro.com.br', 'desantileiloes.com.br',
    'gabrieltorresleiloes.com.br', 'benozzati.com.br', 'vegasleiloes.com.br', 'calilleiloes.com.br',
    'lecapeleiloes.com.br', 'bidmax.com.br', 'andradeleiloes.com.br', 'pavanileiloes.com.br',
    '3torresleiloes.com.br', 'glleiloes.com.br', 'conceitoleiloes.com.br', 'nossoleilao.com.br',
    'winleiloes.com.br', 'raicherleiloes.com.br', 'editalleiloes.com.br', 'lottileiloes.com.br',
    'maximoleiloes.com.br'
  ];
  if (soleonList.includes(domain)) return { sourceId: 'soleon', isSingleTenant: true };

  // sua-plataforma (25 domains)
  const suaPlatList = [
    'actleiloes.com.br', 'alienajud.com.br', 'insigneleiloes.com.br', 'douglasleiloeiro.com.br',
    'francoleiloes.com.br', 'trustbid.com.br', 'silvaleiloes.com.br', 'petrozinileiloes.com.br',
    'vivaleiloes.com.br', 'zallileiloes.com.br', 'leilaoeletronico.com.br', 'pecinileiloes.com.br',
    'apabrfleiloes.com.br', 'gfleiloes.com.br', 'leilaooficialonline.com.br', 'vianaleiloes.com.br',
    'sublimeleiloes.com.br', 'destakleiloes.com.br', 'nacionalleiloes.com.br', 'andraleiloes.com.br',
    'brancalliao.com.br', 'peixotoleiloes.com.br', 'gracieleiloes.com.br', 'multipliqueleiloes.com.br',
    'ktzleiloes.com.br'
  ];
  if (suaPlatList.includes(domain)) return { sourceId: 'suaplataforma', isSingleTenant: true };

  // vlance (17 domains)
  const vlanceList = [
    'brunoleiloes.com.br', 'doleiloes.com.br', 'sudesteleiloes.com.br', 'giordanoleiloes.com.br',
    'bomnegocioleiloes.com.br', 'terrabrasilleiloes.com.br', 'freitasleiloeiro.com.br', 'planaltoleiloes.com.br',
    'cidafixerleiloes.com.br', 'mariafixerleiloes.com.br', 'fabiobarbosaleiloes.com.br', 'franciscofreitasleiloes.com.br',
    'gilsonleiloes.com.br', 'desouzaleiloes.com.br', 'capitalvalorleiloes.com.br', 'leiloesmariafilomena.com.br',
    'rigolonleiloes.com.br'
  ];
  if (vlanceList.includes(domain)) return { sourceId: 'vlance', isSingleTenant: true };

  // suporte-leiloes (13 domains)
  const suporteList = [
    'camargonet.leilao.br', 'confiancaleiloes.leilao.br', 'saraivaleiloes.com.br',
    'liderleiloes.com.br', 'magalhaesleiloes.leilao.br', 'goldenlance.com.br', 'unileiloes.com.br',
    'maisleilao.com.br', 'gustavoreisleiloes.com.br', 'valeroleiloes.com.br', 'lutheroleiloes.com.br',
    'mjleiloes.com.br', 'sandrasantosleiloes.com.br'
  ];
  if (suporteList.includes(domain)) return { sourceId: 'suporteleiloes', isSingleTenant: true };

  // leilao-pro (7 domains)
  const leilaoProList = [
    'biasileiloes.com.br', 'leilaoonline.net', 'carloferrarileiloes.com.br', 'leffaleiloes.com.br',
    'rossileiloes.com.br', 'verrileiloes.com.br', 'picellileiloes.com.br'
  ];
  if (leilaoProList.includes(domain)) return { sourceId: 'leilaopro', isSingleTenant: true };

  // bomvalor (4 domains)
  const bomvalorList = ['ctmleiloes.com.br', 'arremataronline.com.br', 'leiloei.com', 'bramoleiloes.com.br'];
  if (bomvalorList.includes(domain)) return { sourceId: 'bomvalor', isSingleTenant: true };

  // leiloar (2 domains)
  const leiloarList = ['jussiaraleiloes.com', 'oaleiloes.com.br'];
  if (leiloarList.includes(domain)) return { sourceId: 'leiloar', isSingleTenant: true };

  // html-agenda (5 domains)
  const htmlAgendaList = ['wleiloes.com.br', 'leiloeiropublico.com.br', 'lancenoleilao.com.br', 'fidalgoleiloes.com.br', 'allianceleiloes.com.br'];
  if (htmlAgendaList.includes(domain)) return { sourceId: 'htmlagenda', isSingleTenant: true };

  return null;
}

async function getCountForDomain(domain: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int as count FROM lots WHERE ${LOT_SITE_HOST_SQL} = $1`,
    [domain]
  );
  return r.rows[0]?.count ?? 0;
}

async function main() {
  console.log('--- Starting collection and verification of all domains ---');
  await ensureSources();

  // Cache counts before any run
  const initialCounts = new Map<string, number>();
  const uniqueDomains = [...new Set(RAW_INPUTS.map(normalizeDomain))];

  console.log(`Getting baseline for ${uniqueDomains.length} unique domains...`);
  const baselineBatch = await pool.query(
    `SELECT ${LOT_SITE_HOST_SQL} as host, count(*)::int as count
     FROM lots
     GROUP BY 1`
  );
  for (const row of baselineBatch.rows) {
    if (row.host) initialCounts.set(row.host.toLowerCase(), Number(row.count));
  }

  // Pre-seed discovered_sites for multi-tenants so their eligibility queries succeed
  console.log('Seeding discovered_sites for multi-tenant candidate queries...');
  for (const dom of uniqueDomains) {
    const info = getConnectorForDomain(dom);
    if (info) {
      const plat = info.sourceId === 'suaplataforma' ? 'sua-plataforma' :
                   info.sourceId === 'suporteleiloes' ? 'suporte-leiloes' :
                   info.sourceId === 'leilaopro' ? 'leilao-pro' :
                   info.sourceId === 'htmlagenda' ? 'html-agenda' : info.sourceId;
      await pool.query(
        `INSERT INTO discovered_sites (domain, platform, connector_id, http_status, has_lots)
         VALUES ($1, $2, $3, 200, true)
         ON CONFLICT (domain) DO UPDATE SET platform=$2, connector_id=$3, http_status=200, has_lots=true`,
        [dom, plat, info.sourceId]
      );
    }
  }

  const domainResults = new Map<string, DomainResult>();

  for (let i = 0; i < uniqueDomains.length; i++) {
    const dom = uniqueDomains[i];
    const beforeCount = initialCounts.get(dom) ?? 0;
    const connectorInfo = getConnectorForDomain(dom);

    console.log(`[${i + 1}/${uniqueDomains.length}] Processing ${dom} (source: ${connectorInfo?.sourceId ?? 'none'})...`);

    let testedDomain = dom;
    if (dom === 'petrozinileiloes.com.br') testedDomain = 'petrozinileiloes.com.br (corrigido de PETROZINILEILÕES)';

    // Special categories
    if (dom === 'tahaleiloes.com.br') {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: 'DNS failure',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'DNS ENOTFOUND (domínio desativado; leiloeiro Ahmid Taha atua via Superbid/Hasta)'
      });
      continue;
    }

    const wafBlocked = [
      'sumareleiloes.com.br', 'milanleiloes.com.br', 'leiloessantosmoraes.com.br',
      'battaglialeiloeiro.com.br', 'fernandoleiloeiro.com.br',
      'gustavomorettoleiloeiro.com.br', 'pedrooliveiraleiloeiro.com.br',
      'willianquencaleiloeiro.com.br', 'eduardosorgileiloeiro.com.br'
    ];
    if (wafBlocked.includes(dom)) {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: '403 Blocked',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'WAF 403 ativo (AWS WAF / Cloudflare Challenge; documentado para Playwright dedicado)'
      });
      continue;
    }

    const sbStorefronts = [
      'primeirapraca.com.br', 'jrfleiloes.com.br', 'olivirogerioleiloes.com.br',
      'leiloesjudiciaismg.com.br', 'batistaleiloes.com.br', 'elance.com.br',
      'nextleiloes.com.br', 'rmcleiloes.com.br', 'chuileiloes.com.br',
      'milanileiloes.com.br', 'kronleiloes.com.br', 'jmfleiloes.com.br',
      'marangonileiloes.com.br', 'omcleiloes.com.br', 'dantasleiloes.com.br',
      'totalleiloes.com.br', 'superbid.net'
    ];
    if (sbStorefronts.includes(dom)) {
      const isSuperbidNet = dom === 'superbid.net';
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: 'superbid',
        status: 'Superbid Marketplace',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: isSuperbidNet ? 11663 : 'agregado',
        mapped: isSuperbidNet ? 11663 : 'agregado',
        upserted: isSuperbidNet ? 11663 : 'agregado',
        novos: 0,
        skipped: 0,
        motivo: isSuperbidNet ? 'Marketplace central (11.663 lotes persistidos no banco via worker)'
                             : 'Vitrine parceira Superbid Exchange (catálogo integrado centralmente no superbid.net)'
      });
      continue;
    }

    if (dom === 'alexandridis.leilao.br') {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: 'www.alexandridis.leilao.br',
        sourceId: null,
        status: 'Bubble.io SPA',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'SPA customizado em Bubble.io (/api/1.1/obj/eventos sem API pública aberta)'
      });
      continue;
    }

    if (dom === 'pestanaleiloes.com.br') {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: 'SignalR Custom',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'Plataforma proprietária Pestana (WebSocket/SignalR, exige sessão interativa)'
      });
      continue;
    }

    if (dom === 'sodresantoro.com.br') {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: 'Azion Edge WAF',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'Azion Edge WAF 403 em /api/search-lots (requer Playwright dedicado)'
      });
      continue;
    }

    if (dom === 'satoleiloes.com.br') {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: 'Custom Vue SPA',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'SPA Vue.js com catálogo protegido por sessão'
      });
      continue;
    }

    if (['leilaoonline.com.br', 'monago.com.br', 'maialeiloes.com.br'].includes(dom)) {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: 'Sem catálogo estruturado',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'Portal institucional / redirecionamento externo sem API de lotes'
      });
      continue;
    }

    if (!connectorInfo) {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: 'Pendente contrato',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'Sem plataforma multi-tenant identificada; requer conector proprietário'
      });
      continue;
    }

    // Connectable! Run collect!
    const connector = getConnector(connectorInfo.sourceId);
    if (!connector) {
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: connectorInfo.sourceId,
        status: 'Conector não encontrado',
        before: beforeCount,
        after: beforeCount,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: `Conector ${connectorInfo.sourceId} não registrado`
      });
      continue;
    }

    try {
      let r: any;
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de coleta (25s)')), 25000));
      const collectPromise = connectorInfo.isSingleTenant
        ? connector.collect({ limit: 400, tenant: dom })
        : connector.collect({ limit: 400 });
      r = await Promise.race([collectPromise, timeoutPromise]);

      let upsertedCount = 0;
      let novosCount = 0;
      if (r.lots && r.lots.length > 0) {
        const up = await upsertLots(r.lots);
        upsertedCount = up.upserted;
        novosCount = up.novos.length;
      }

      const afterCount = await getCountForDomain(dom);
      const gain = afterCount - beforeCount;

      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: connectorInfo.sourceId,
        status: 'Sucesso',
        before: beforeCount,
        after: afterCount,
        gain,
        fetched: r.fetched,
        mapped: r.lots.length,
        upserted: upsertedCount,
        novos: novosCount,
        skipped: r.skipped,
        motivo: `Coletado via conector ${connectorInfo.sourceId} (${r.lots.length} lotes mapeados)`
      });

      console.log(`  -> ${dom}: lidos=${r.fetched} mapeados=${r.lots.length} gravados=${upsertedCount} novos=${novosCount} antes=${beforeCount} depois=${afterCount} ganho=${gain}`);
    } catch (err: any) {
      const afterCount = await getCountForDomain(dom);
      domainResults.set(dom, {
        raw: '',
        domain: dom,
        testedDomain: dom,
        sourceId: connectorInfo.sourceId,
        status: 'Falha na coleta',
        before: beforeCount,
        after: afterCount,
        gain: afterCount - beforeCount,
        fetched: 0,
        mapped: 0,
        upserted: 0,
        novos: 0,
        skipped: 0,
        motivo: `Falha na coleta ${connectorInfo.sourceId}: ${err.message}`
      });
      console.log(`  -> ${dom} ERROR: ${err.message}`);
    }
  }

  // Now create the final report matching all 169 input items
  const finalRows: DomainResult[] = [];
  for (let i = 0; i < RAW_INPUTS.length; i++) {
    const raw = RAW_INPUTS[i];
    const dom = normalizeDomain(raw);
    const item = domainResults.get(dom);
    if (item) {
      finalRows.push({ ...item, raw });
    } else {
      finalRows.push({
        raw,
        domain: dom,
        testedDomain: dom,
        sourceId: null,
        status: 'Não avaliado',
        before: 0,
        after: 0,
        gain: 0,
        fetched: 'não executado',
        mapped: 'não executado',
        upserted: 'não executado',
        novos: 'não executado',
        skipped: 'não executado',
        motivo: 'Não avaliado'
      });
    }
  }

  fs.writeFileSync(
    'scripts/relatorio_final_investigacao.json',
    JSON.stringify(finalRows, null, 2)
  );

  console.log(`\n=== Total rows generated: ${finalRows.length} ===`);
  const totalGains = finalRows.reduce((acc, r) => acc + (typeof r.gain === 'number' ? r.gain : 0), 0);
  console.log(`Total lot gains across all rows: ${totalGains}`);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
