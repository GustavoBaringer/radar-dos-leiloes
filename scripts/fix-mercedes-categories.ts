import { pool } from '../src/core/db.js';
import {
  classifyAsset,
  marcaCanonica,
  completaVeiculo,
  buildSearchText,
  parseTitle,
} from '../src/core/normalize.js';
import * as campos from '../src/core/campos.js';

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const dryRun = !aplicar || process.argv.includes('--dry-run');

  console.log('='.repeat(80));
  console.log(`[migracao] Saneamento de Mercedes-Benz, Ônibus, Utilitários e Pesados`);
  console.log(`[migracao] Modo: ${dryRun ? 'DRY-RUN (Simulação - NENHUMA alteração será persistida)' : 'APLICAR (ALTERAÇÕES REAIS SERÃO GRAVADAS NO BANCO)'}`);
  console.log('='.repeat(80));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Busca especificamente lotes com marca MERCEDES-BENZ ou menções a Mercedes/MB/ônibus/utilitários/peças no título
    const res = await client.query(`
      SELECT id, title_raw, source_category, brand, model, version, vehicle_type, asset_type, city, state, seller_name, lot_url, year_make, year_model
      FROM lots
      WHERE (asset_type = 'veiculo' OR asset_type = 'outro')
        AND (
          brand = 'MERCEDES-BENZ'
          OR title_raw ~* '\\b(mercedes|m[\\s./-]*benz|mb|induscar|vito|sprinter|marimar|eixo)\\b'
        )
      ORDER BY id ASC
    `);

    let totalModificados = 0;
    const contadores = {
      caminhao: 0,
      onibus: 0,
      utilitario: 0,
      peca: 0,
      carro: 0,
      outros: 0,
      vwCorrigido: 0,
      citroenCorrigido: 0,
    };

    for (const r of res.rows) {
      const cls = classifyAsset(r.title_raw, r.source_category);
      let assetType = cls.assetType;
      let vehicleType = assetType === 'veiculo' ? cls.vehicleType : (cls.vehicleType === 'peca' ? 'peca' : null);

      // Especial para lote que menciona Sprinter na URL
      if (vehicleType === 'carro' && /sprinter/i.test(r.lot_url ?? '')) {
        vehicleType = 'utilitario';
      }

      // Re-avaliação da marca e modelo via parseTitle
      const p = parseTitle(r.title_raw);
      let brand = r.brand;
      let model = r.model;

      // Corrige falso positivo de VW virando Mercedes por causa do sufixo MB
      if (
        r.brand === 'MERCEDES-BENZ' &&
        (/\b(gol|vwgol|voyage|polo|fox|saveiro|virtus|crossfox|spacefox)\b/i.test(r.title_raw) || /^vw\b/i.test(r.title_raw))
      ) {
        brand = 'VOLKSWAGEN';
        model = p.model ?? model;
        contadores.vwCorrigido++;
      } else if (r.brand === 'MERCEDES-BENZ' && /\bc4 pallas\b/i.test(r.title_raw)) {
        brand = 'CITROEN';
        model = 'C4';
        contadores.citroenCorrigido++;
      } else {
        brand = marcaCanonica(brand, r.title_raw, vehicleType);
        if (p.model && (!model || model === 'MB' || model === 'GLA')) {
          model = p.model;
        }
      }

      const extra = completaVeiculo(r.title_raw, brand, vehicleType);
      const version = r.version || extra?.version || null;
      model = model ?? extra?.model ?? null;
      const yearMake = r.year_make ?? extra?.yearMake ?? null;
      const yearModel = r.year_model ?? extra?.yearModel ?? null;

      // Se virou peça / outro
      if (assetType === 'outro' && cls.vehicleType === 'peca') {
        vehicleType = 'peca';
      }

      // Verifica se houve alteração relevante
      const mudouAsset = assetType !== r.asset_type;
      const mudouVehicle = vehicleType !== r.vehicle_type;
      const mudouBrand = brand !== r.brand;
      const mudouModel = model !== r.model;

      if (!mudouAsset && !mudouVehicle && !mudouBrand && !mudouModel) {
        continue;
      }

      totalModificados++;
      if (vehicleType === 'caminhao') contadores.caminhao++;
      else if (vehicleType === 'onibus') contadores.onibus++;
      else if (vehicleType === 'utilitario') contadores.utilitario++;
      else if (vehicleType === 'peca') contadores.peca++;
      else if (vehicleType === 'carro') contadores.carro++;
      else contadores.outros++;

      console.log(`[Lote #${r.id}] "${r.title_raw}" (cat: "${r.source_category}")`);
      if (mudouAsset || mudouVehicle) {
        console.log(`  Tipo:   ${r.asset_type}/${r.vehicle_type} -> ${assetType}/${vehicleType}`);
      }
      if (mudouBrand || mudouModel) {
        console.log(`  Modelo: ${r.brand ?? 's/marca'} ${r.model ?? ''} -> ${brand ?? 's/marca'} ${model ?? ''}`);
      }

      if (!dryRun) {
        const titleDisplay = campos.tituloVeiculo({
          brand,
          model,
          version,
          yearMake,
          yearModel,
          titleRaw: r.title_raw,
        });

        const searchText = buildSearchText([
          r.title_raw,
          brand,
          model,
          version,
          r.city,
          r.state,
          r.seller_name,
        ]);

        await client.query(
          `
          UPDATE lots
          SET asset_type = $1,
              vehicle_type = $2,
              brand = $3,
              model = $4,
              year_make = COALESCE(lots.year_make, $5),
              year_model = COALESCE(lots.year_model, $6),
              title_display = $7,
              search_text = $8
          WHERE id = $9
        `,
          [assetType, vehicleType, brand, model, yearMake, yearModel, titleDisplay, searchText, r.id],
        );
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\n' + '='.repeat(80));
      console.log(`[migracao] SIMULAÇÃO CONCLUÍDA (ROLLBACK executado, nada foi alterado)`);
      console.log(`  - Total de lotes que seriam corrigidos: ${totalModificados}`);
      console.log(`  - Caminhões: ${contadores.caminhao}`);
      console.log(`  - Ônibus: ${contadores.onibus}`);
      console.log(`  - Utilitários: ${contadores.utilitario}`);
      console.log(`  - Peças/eixos: ${contadores.peca}`);
      console.log(`  - Carros: ${contadores.carro}`);
      console.log(`  - Outros: ${contadores.outros}`);
      console.log(`  - Falsos positivos VW corrigidos: ${contadores.vwCorrigido}`);
      console.log(`  - Falsos positivos Citroën corrigidos: ${contadores.citroenCorrigido}`);
      console.log('='.repeat(80));
      console.log(`Para gravar as alterações no banco de dados, execute:`);
      console.log(`  node --env-file=.env --import tsx scripts/fix-mercedes-categories.ts --aplicar\n`);
    } else {
      await client.query('COMMIT');
      console.log('\n' + '='.repeat(80));
      console.log(`[migracao] SUCESSO: Migração persistida no banco com COMMIT!`);
      console.log(`  - Total de lotes atualizados no banco: ${totalModificados}`);
      console.log(`  - Caminhões: ${contadores.caminhao}`);
      console.log(`  - Ônibus: ${contadores.onibus}`);
      console.log(`  - Utilitários: ${contadores.utilitario}`);
      console.log(`  - Peças/eixos: ${contadores.peca}`);
      console.log(`  - Carros: ${contadores.carro}`);
      console.log(`  - Outros: ${contadores.outros}`);
      console.log(`  - Falsos positivos VW corrigidos: ${contadores.vwCorrigido}`);
      console.log(`  - Falsos positivos Citroën corrigidos: ${contadores.citroenCorrigido}`);
      console.log('='.repeat(80) + '\n');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migracao] Erro na migração, efetuado ROLLBACK:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
