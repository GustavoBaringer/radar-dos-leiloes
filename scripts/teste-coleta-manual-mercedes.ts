import { pool } from '../src/core/db.js';
import { upsertLots } from '../src/core/repo.js';
import type { CanonicalLot } from '../src/core/types.js';

async function main() {
  console.log('[teste-coleta] Iniciando teste de ingestão/cadastro manual via upsertLots...');

  // Mock dos lotes reais reportados nos prints e encontrados na base
  const lotesParaColeta: CanonicalLot[] = [
    {
      sourceId: 'soleon',
      externalId: 'purcenaleiloes.com.br:2377',
      lotUrl: 'https://purcenaleiloes.com.br/item/2377/detalhes?page=2',
      titleRaw: 'MERCEDES-BENZ/OF 1519 R.ORE',
      sourceCategory: 'veiculo',
      city: 'Vitória de Santo Antão',
      state: 'PE',
      currentBid: 27800,
      minBid: 27800,
      sellerName: 'Prefeitura',
      auctioneerName: 'Carla Karine Santos',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'vlance',
      externalId: '209214',
      lotUrl: 'https://paulorochaleiloes.com.br/lote/419291',
      titleRaw: 'M.BENZ LS 1938 - 03/03 - Brumado/BA',
      sourceCategory: null,
      city: 'Brumado',
      state: 'BA',
      currentBid: 135000,
      minBid: 135000,
      sellerName: 'Vara Cível',
      auctioneerName: 'Paulo Cézar Rocha',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'soleon',
      externalId: 'gspleiloes.com.br:1257',
      lotUrl: 'https://gspleiloes.com.br/item/1257/detalhes?page=1',
      titleRaw: 'M. BENZ / LS 1935',
      sourceCategory: null,
      city: 'Curitiba',
      state: 'PR',
      currentBid: 40000,
      minBid: 40000,
      sellerName: 'Empresa de Transporte',
      auctioneerName: 'Claudio Cesar Kuss',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'soleon',
      externalId: 'joaoemilio.com.br:209580',
      lotUrl: 'https://joaoemilio.com.br/item/209580/detalhes?page=1',
      titleRaw: 'MERCEDES-BENZ 315 CDI STREET C 2024 / 2025 BRANCA DIESEL (Nº FIPE 214795)',
      sourceCategory: null,
      city: 'Rio de Janeiro',
      state: 'RJ',
      currentBid: 95000,
      minBid: 95000,
      sellerName: 'Banco',
      auctioneerName: 'João Emílio',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'copart',
      externalId: '322114',
      lotUrl: 'https://www.copart.com.br/lot/322114',
      titleRaw: '2018 MERCEDES BENZ CLASSE C',
      sourceCategory: 'Automóveis',
      city: 'Pirapora',
      state: 'SP',
      currentBid: 15100,
      minBid: 15100,
      sellerName: 'Seguradora',
      auctioneerName: 'Copart Leilões',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
  ];

  const lidos = lotesParaColeta.length;
  const mapeados = lotesParaColeta.length;
  let descartados = 0;

  console.log(`[teste-coleta] Ingerindo ${lidos} lotes de teste via upsertLots...`);
  const resultado = await upsertLots(lotesParaColeta);

  console.log(
    `[teste-coleta] Resultado da coleta: lidos=${lidos} mapeados=${mapeados} gravados=${resultado.upserted} descartados=${descartados}`,
  );

  // Verificação no banco dos lotes gravados
  const res = await pool.query(`
    SELECT source_id, external_id, title_raw, title_display, vehicle_type, asset_type, brand
    FROM lots
    WHERE external_id IN ('purcenaleiloes.com.br:2377', '209214', 'gspleiloes.com.br:1257', 'joaoemilio.com.br:209580', '322114')
    ORDER BY id
  `);

  console.log('\n[teste-coleta] Estado dos lotes após nova coleta/upsert:');
  for (const r of res.rows) {
    console.log(
      `  • ${r.source_id.padEnd(8)} | ${String(r.vehicle_type).padEnd(10)} | ${String(r.brand).padEnd(14)} | ${r.title_display} (raw: ${r.title_raw})`,
    );
  }

  // Validação estrita
  const onibus = res.rows.find((r) => r.external_id === 'purcenaleiloes.com.br:2377');
  const caminhao1 = res.rows.find((r) => r.external_id === '209214');
  const caminhao2 = res.rows.find((r) => r.external_id === 'gspleiloes.com.br:1257');
  const utilitario = res.rows.find((r) => r.external_id === 'joaoemilio.com.br:209580');
  const carro = res.rows.find((r) => r.external_id === '322114');

  if (onibus?.vehicle_type !== 'onibus') throw new Error(`OF 1519 não foi gravado como onibus: ${onibus?.vehicle_type}`);
  if (caminhao1?.vehicle_type !== 'caminhao') throw new Error(`LS 1938 não foi gravado como caminhao: ${caminhao1?.vehicle_type}`);
  if (caminhao2?.vehicle_type !== 'caminhao') throw new Error(`LS 1935 não foi gravado como caminhao: ${caminhao2?.vehicle_type}`);
  if (utilitario?.vehicle_type !== 'utilitario') throw new Error(`315 CDI não foi gravado como utilitario: ${utilitario?.vehicle_type}`);
  if (carro?.vehicle_type !== 'carro') throw new Error(`Classe C não foi gravado como carro: ${carro?.vehicle_type}`);

  console.log('\n✅ Todos os lotes foram gravados e validados com 100% de sucesso nas categorias esperadas!');
  await pool.end();
}

main().catch((err) => {
  console.error('[teste-coleta] Falha no teste:', err);
  process.exit(1);
});
