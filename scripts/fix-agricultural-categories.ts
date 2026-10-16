import { pool } from '../src/core/db.js';
import {
  classifyAsset,
  completaVeiculo,
  buildSearchText,
  parseTitle,
} from '../src/core/normalize.js';
import * as campos from '../src/core/campos.js';

async function main() {
  const isDryRun = process.argv.includes('--dry-run') || !process.argv.includes('--aplicar');
  console.log(`[migracao-agro] Iniciando saneamento de máquinas e implementos agrícolas (modo: ${isDryRun ? 'DRY-RUN' : 'APLICAR'})...`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Busca lotes candidatos com termos agrícolas atualmente classificados como caminhao ou carro
    const res = await client.query(`
      SELECT id, title_raw, source_category, brand, model, version, vehicle_type, asset_type, city, state, seller_name, lot_url, source_id
      FROM lots
      WHERE (
        title_raw ~* '\\m(colheitade[ir]a|plataforma|trato(r|r\\s+agricola|\\s+agricola)|pulverizador|plantade[ir]a|grade (arad[ou]ra|niveladora|pesada)|semeade[ir]a|semeadora|ensiladeira|ro[cç]adeira|adubade[ir]a|adubadora|escarificador|arado|ceifadeira|enfardade[ir]a|enfardadora|subsolador)\\M'
        OR title_raw ~* '\\m(new holland|massey ferguson|case ih|john deere|valtra)\\M'
      )
      AND vehicle_type IN ('caminhao', 'carro')
      ORDER BY id DESC
    `);

    let totalAtualizados = 0;
    const contadores: Record<string, number> = {
      maquina: 0,
      caminhao_preservado: 0,
      carro_preservado: 0,
      outros: 0,
    };

    for (const r of res.rows) {
      // Reclassifica com as regras atualizadas de normalize.ts
      const cls = classifyAsset(r.title_raw, r.source_category);
      const assetType = cls.assetType;
      const vehicleType = assetType === 'veiculo' ? cls.vehicleType : null;

      // Proteção explícita de segurança: cavalos mecânicos e caminhões com guincho plataforma nunca viram máquina
      const ehCaminhaoTratorOuGuincho = /\b(caminh[aã]o|c\.)\s+trator\b|\bcavalo\s+mecanico\b|\b(?:caminh[aã]o|guincho)\b.{0,30}?\bplataforma\b/i.test(r.title_raw);
      if (ehCaminhaoTratorOuGuincho && vehicleType === 'maquina') {
        console.warn(`[IGNORADO - SEGURANÇA] Lote #${r.id} "${r.title_raw.slice(0, 50)}" protegido como caminhão.`);
        contadores.caminhao_preservado++;
        continue;
      }

      // Se não mudou, segue adiante
      const mudou = assetType !== r.asset_type || vehicleType !== r.vehicle_type;
      if (!mudou) {
        if (r.vehicle_type === 'caminhao') contadores.caminhao_preservado++;
        if (r.vehicle_type === 'carro') contadores.carro_preservado++;
        continue;
      }

      // Re-avaliação de marca/modelo se aplicável
      const p = parseTitle(r.title_raw);
      const brand = r.brand ?? p.brand ?? null;
      const model = r.model ?? p.model ?? null;
      const extra = completaVeiculo(r.title_raw, brand, vehicleType);
      const version = r.version || extra?.version || null;

      if (vehicleType === 'maquina') contadores.maquina++;
      else contadores.outros++;

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
      console.log(
        `[${isDryRun ? 'CANDIDATO' : 'ATUALIZADO'}] #${r.id} (${r.source_id}) "${r.title_raw.slice(0, 60)}" -> tipo: ${r.vehicle_type} -> ${vehicleType}`,
      );
    }

    if (isDryRun) {
      await client.query('ROLLBACK');
      console.log(`\n[DRY RUN CONCLUÍDO] ${totalAtualizados} lotes seriam alterados no banco. (Execute com --aplicar para efetivar)`);
    } else {
      await client.query('COMMIT');
      console.log(`\n[MIGRAÇÃO CONCLUÍDA] ${totalAtualizados} lotes saneados com sucesso e persistidos no Postgres.`);
    }

    console.log('Resumo:', contadores);
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
