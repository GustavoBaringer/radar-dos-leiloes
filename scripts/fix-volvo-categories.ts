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
  const isDryRun = process.argv.includes('--dry-run');
  console.log(`[migracao] Iniciando migração e saneamento de veículos Volvo e pesados (dry-run: ${isDryRun})...`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Busca todos os lotes que têm marca VOLVO ou menção a volvo/modelos de caminhão/ônibus no título
    const res = await client.query(`
      SELECT id, title_raw, source_category, brand, model, version, vehicle_type, asset_type, city, state, seller_name, lot_url
      FROM lots
      WHERE (
        title_raw ILIKE '%volvo%'
        OR brand = 'VOLVO'
        OR title_raw ~* '\\y(nh\\s*12|nl\\s*1[02]|fh\\s*\\d{2,3}|fm\\s*\\d{2,3}|vm\\s*\\d{2,3}|fmx|irizar)\\y'
      )
    `);

    let totalAtualizados = 0;
    const contadores = {
      caminhao: 0,
      onibus: 0,
      suv: 0,
      carro: 0,
      peca: 0,
    };

    for (const r of res.rows) {
      // Reclassifica com as regras atualizadas
      const cls = classifyAsset(r.title_raw, r.source_category);
      let assetType = cls.assetType;
      let vehicleType = assetType === 'veiculo' ? cls.vehicleType : null;

      // Re-avaliação da marca e modelo via parseTitle
      const p = parseTitle(r.title_raw);
      let brand = r.brand;
      let model = r.model;

      if (brand === 'VOLVO' || p.brand === 'VOLVO') {
        brand = 'VOLVO';
        if (p.model && (!model || model === 'GERAL' || model === 'LOTE')) {
          model = p.model;
        }
      }

      const extra = completaVeiculo(r.title_raw, brand, vehicleType);
      const version = r.version || extra?.version || null;

      // Se virou peça / outro
      if (assetType === 'outro' && cls.vehicleType === 'peca') {
        vehicleType = 'peca';
      }

      // Verifica se houve alteração relevante
      const mudou =
        assetType !== r.asset_type ||
        vehicleType !== r.vehicle_type ||
        brand !== r.brand ||
        model !== r.model;

      if (!mudou) continue;

      if (vehicleType === 'caminhao') contadores.caminhao++;
      else if (vehicleType === 'onibus') contadores.onibus++;
      else if (vehicleType === 'suv') contadores.suv++;
      else if (vehicleType === 'carro') contadores.carro++;
      else if (vehicleType === 'peca') contadores.peca++;

      // Atualiza titleDisplay e searchText
      const titleDisplay = campos.tituloVeiculo({
        brand,
        model: model ?? extra?.model ?? null,
        version,
        yearMake: null,
        yearModel: null,
        titleRaw: r.title_raw,
      });

      const searchText = buildSearchText([
        r.title_raw,
        titleDisplay,
        brand,
        model,
        version,
        r.seller_name,
        r.city,
        r.state,
      ]);

      if (!isDryRun) {
        await client.query(
          `
          UPDATE lots
          SET
            asset_type = $1,
            vehicle_type = $2,
            brand = $3,
            model = $4,
            version = $5,
            title_display = $6,
            search_text = $7
          WHERE id = $8
        `,
          [
            assetType,
            vehicleType,
            brand,
            model,
            version,
            titleDisplay,
            searchText,
            r.id,
          ],
        );
      }

      totalAtualizados++;
      if (totalAtualizados <= 20 || /volvo/i.test(r.title_raw)) {
        console.log(
          `[OK] #${r.id} "${r.title_raw.slice(0, 50)}" -> asset: ${r.asset_type}->${assetType}, tipo: ${r.vehicle_type}->${vehicleType}, brand: ${brand}, model: ${model}`,
        );
      }
    }

    if (isDryRun) {
      await client.query('ROLLBACK');
      console.log(`\n[DRY RUN COMPLETO] ${totalAtualizados} lotes seriam alterados no banco.`);
    } else {
      await client.query('COMMIT');
      console.log(`\n[MIGRAÇÃO CONCLUÍDA COM SUCESSO] ${totalAtualizados} lotes saneados e persistidos no Postgres.`);
    }

    console.log('Resumo das alterações:', contadores);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro na migração:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
