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
  console.log('[migracao] Iniciando migração e saneamento de veículos Mercedes-Benz e pesados...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Busca todos os lotes que têm marca MERCEDES-BENZ ou menção a mercedes/mb no título
    const res = await client.query(`
      SELECT id, title_raw, source_category, brand, model, version, vehicle_type, asset_type, city, state, seller_name, lot_url
      FROM lots
      WHERE asset_type = 'veiculo' OR asset_type = 'outro'
    `);

    let totalAtualizados = 0;
    const contadores = {
      caminhao: 0,
      onibus: 0,
      utilitario: 0,
      peca: 0,
      vwCorrigido: 0,
      citroenCorrigido: 0,
    };

    for (const r of res.rows) {
      const cls = classifyAsset(r.title_raw, r.source_category);
      let assetType = cls.assetType;
      let vehicleType = assetType === 'veiculo' ? cls.vehicleType : null;

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
      else if (vehicleType === 'utilitario') contadores.utilitario++;
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
            title_display = $5,
            search_text = $6
        WHERE id = $7
      `,
        [assetType, vehicleType, brand, model, titleDisplay, searchText, r.id],
      );

      totalAtualizados++;
    }

    await client.query('COMMIT');
    console.log(`[migracao] Migração concluída com sucesso!`);
    console.log(`  - Total de lotes atualizados: ${totalAtualizados}`);
    console.log(`  - Caminhões corrigidos: ${contadores.caminhao}`);
    console.log(`  - Ônibus corrigidos: ${contadores.onibus}`);
    console.log(`  - Utilitários corrigidos: ${contadores.utilitario}`);
    console.log(`  - Peças/pneus corrigidos: ${contadores.peca}`);
    console.log(`  - Falsos positivos VW corrigidos: ${contadores.vwCorrigido}`);
    console.log(`  - Falsos positivos Citroën corrigidos: ${contadores.citroenCorrigido}`);
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
