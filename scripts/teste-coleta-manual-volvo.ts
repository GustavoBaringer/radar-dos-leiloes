import { pool } from '../src/core/db.js';
import { upsertLots } from '../src/core/repo.js';
import type { CanonicalLot } from '../src/core/types.js';

async function main() {
  console.log('[teste-coleta-volvo] Iniciando teste de ingestão/cadastro manual via upsertLots...');

  // Mock dos lotes reais reportados nos prints e encontrados na base
  const lotesParaColeta: CanonicalLot[] = [
    {
      sourceId: 'superbid',
      externalId: 'test-volvo-vm-260',
      lotUrl: 'https://www.superbid.net/oferta/test-volvo-vm-260',
      titleRaw: 'Volvo VM 260 6X2R 2008',
      sourceCategory: 'Hatches',
      city: 'Mafra',
      state: 'SC',
      currentBid: 66250,
      minBid: 66250,
      sellerName: 'Comitente',
      auctioneerName: 'HELCIO KRONBERG LEILOEIRO PUBLICO OFICIAL',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'superbid',
      externalId: 'test-volvo-vm-270',
      lotUrl: 'https://www.superbid.net/oferta/test-volvo-vm-270',
      titleRaw: 'Volvo VM 270 6X2R 2014',
      sourceCategory: 'Carros',
      city: 'Ponte Alta do Norte',
      state: 'SC',
      currentBid: 124750,
      minBid: 124750,
      sellerName: 'Comitente',
      auctioneerName: 'HELCIO KRONBERG LEILOEIRO PUBLICO OFICIAL',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'soleon',
      externalId: 'test-volvo-nh12',
      lotUrl: 'https://leiloes.com.br/lote/test-nh12',
      titleRaw: 'VOLVO/NH12380 4X2T, 99/00, PLACA: J__-___0, DIESEL, AZUL',
      sourceCategory: null,
      city: 'Curitiba',
      state: 'PR',
      currentBid: 85000,
      minBid: 85000,
      sellerName: 'Vara de Família',
      auctioneerName: 'Leiloeiro Oficial',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'hastapublica',
      externalId: 'test-volvo-irizar',
      lotUrl: 'https://hastapublica.com.br/lote/test-irizar',
      titleRaw: 'Ônibus Volvo Irizar 16 PB R, ano/modelo 2013/2014',
      sourceCategory: null,
      city: 'São Paulo',
      state: 'SP',
      currentBid: 210000,
      minBid: 210000,
      sellerName: 'Empresa',
      auctioneerName: 'Hasta Pública',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'copart',
      externalId: 'test-volvo-c30',
      lotUrl: 'https://www.copart.com.br/lot/test-c30',
      titleRaw: 'Volvo C30 (2P) 2009/2010',
      sourceCategory: 'Carros',
      city: 'Eusébio',
      state: 'CE',
      currentBid: 8000,
      minBid: 8000,
      sellerName: 'Banco',
      auctioneerName: 'Leiloeiro Oficial',
      closingModel: 'timer_por_lote',
      sourceTz: 'America/Sao_Paulo',
      status: 'aberto',
      photos: [],
    },
    {
      sourceId: 'copart',
      externalId: 'test-volvo-xc60',
      lotUrl: 'https://www.copart.com.br/lot/test-xc60',
      titleRaw: 'Volvo XC60 2.0 T5',
      sourceCategory: 'Veículos',
      city: 'São Paulo',
      state: 'SP',
      currentBid: 55000,
      minBid: 55000,
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

  console.log(`[teste-coleta-volvo] Ingerindo ${lidos} lotes de teste via upsertLots...`);
  const resultado = await upsertLots(lotesParaColeta);

  console.log(
    `[teste-coleta-volvo] Resultado da coleta: lidos=${lidos} mapeados=${mapeados} gravados=${resultado.upserted} descartados=${descartados}`,
  );

  // Verificação no banco dos lotes gravados
  const res = await pool.query(`
    SELECT source_id, external_id, title_raw, title_display, vehicle_type, asset_type, brand
    FROM lots
    WHERE external_id IN (
      'test-volvo-vm-260',
      'test-volvo-vm-270',
      'test-volvo-nh12',
      'test-volvo-irizar',
      'test-volvo-c30',
      'test-volvo-xc60'
    )
    ORDER BY id
  `);

  console.log('\n[teste-coleta-volvo] Estado dos lotes após nova coleta/upsert:');
  for (const r of res.rows) {
    console.log(
      `  • ${r.source_id.padEnd(12)} | ${String(r.vehicle_type).padEnd(10)} | ${String(r.brand).padEnd(10)} | ${r.title_display} (raw: ${r.title_raw})`,
    );
  }

  // Validação estrita
  const vm260 = res.rows.find((r) => r.external_id === 'test-volvo-vm-260');
  const vm270 = res.rows.find((r) => r.external_id === 'test-volvo-vm-270');
  const nh12 = res.rows.find((r) => r.external_id === 'test-volvo-nh12');
  const irizar = res.rows.find((r) => r.external_id === 'test-volvo-irizar');
  const c30 = res.rows.find((r) => r.external_id === 'test-volvo-c30');
  const xc60 = res.rows.find((r) => r.external_id === 'test-volvo-xc60');

  if (vm260?.vehicle_type !== 'caminhao') throw new Error(`VM 260 não foi gravado como caminhao: ${vm260?.vehicle_type}`);
  if (vm270?.vehicle_type !== 'caminhao') throw new Error(`VM 270 não foi gravado como caminhao: ${vm270?.vehicle_type}`);
  if (nh12?.vehicle_type !== 'caminhao') throw new Error(`NH 12 não foi gravado como caminhao: ${nh12?.vehicle_type}`);
  if (irizar?.vehicle_type !== 'onibus') throw new Error(`Ônibus Irizar não foi gravado como onibus: ${irizar?.vehicle_type}`);
  if (c30?.vehicle_type !== 'carro') throw new Error(`C30 não foi gravado como carro: ${c30?.vehicle_type}`);
  if (xc60?.vehicle_type !== 'suv') throw new Error(`XC60 não foi gravado como suv: ${xc60?.vehicle_type}`);

  console.log('\n✅ Todos os lotes Volvo foram gravados e validados com 100% de sucesso nas categorias esperadas!');

  // Limpeza dos lotes de teste
  await pool.query(`
    DELETE FROM lots
    WHERE external_id IN (
      'test-volvo-vm-260',
      'test-volvo-vm-270',
      'test-volvo-nh12',
      'test-volvo-irizar',
      'test-volvo-c30',
      'test-volvo-xc60'
    )
  `);
  console.log('[teste-coleta-volvo] Limpeza de lotes de teste concluída.');

  await pool.end();
}

main().catch((err) => {
  console.error('[teste-coleta-volvo] Falha no teste:', err);
  process.exit(1);
});
