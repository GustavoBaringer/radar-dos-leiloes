/**
 * Encerramento de lote.
 *
 * A regra de "este lote venceu" existia só como filtro de LEITURA na busca
 * (`VENCIDO` em repo.ts): a listagem escondia o lote, mas a coluna `status`
 * continuava dizendo 'aberto', e a página do lote — que lê a coluna crua —
 * mostrava aberto. Aqui a mesma regra vira ESCRITA, uma vez por minuto.
 *
 * A expressão mora neste arquivo e o repo.ts a importa: duas cópias da regra
 * de vencimento divergiriam, e o sintoma seria a listagem e a página do lote
 * discordando de novo.
 */
import { query } from './db.js';
import { VERIFICADORES, temVerificador, type LoteParaVerificar, type Veredito } from './verificacao.js';

/**
 * Lote vencido pelo relógio.
 *
 * Timer por lote vence pelo FIM publicado. Pregão em horário marcado e
 * encerramento sequencial vencem pelo INÍCIO, sem janela de tolerância: a fonte
 * não publica fim, e testar tolerância de 6h e 3h deixou lote da manhã visível
 * à tarde. Lote em pregão é binário — ou está sendo vendido, ou já foi.
 *
 * O COALESCE não é adorno: lote com timer e sem fim publicado deixa a expressão
 * em NULL, e `NOT NULL` também é NULL, que o WHERE trata como falso. Foi assim
 * que 409 lotes ativos sumiram da busca em silêncio.
 *
 * Sem saber se venceu, o certo é NÃO tratar como vencido — quem fecha esses é a
 * regra de ausência abaixo, que não precisa arbitrar prazo nenhum.
 */
export const VENCIDO = `COALESCE(
  (closing_model = 'timer_por_lote' AND auction_end_utc < now())
  OR (closing_model <> 'timer_por_lote' AND auction_start_utc <= now())
, FALSE)`;

/** Quantas varreduras completas seguidas sem ver o lote antes de encerrá-lo. */
const CICLOS_PARA_AUSENCIA = Number(process.env.ENCERRAR_APOS_CICLOS ?? 3);
/** Abaixo disto a coleta é refresh quente, não varredura de catálogo. */
const LIMITE_DE_VARREDURA = 1000;

export interface ResultadoEncerramento {
  porPrazo: number;
  porAusencia: number;
}

/**
 * Fecha o que venceu pelo relógio.
 *
 * `status` passa a ser a verdade, em vez de a busca ter de recalcular a regra a
 * cada consulta — e a página do lote, que lê a coluna, para de discordar da
 * listagem, que aplicava o filtro.
 */
async function encerrarPorPrazo(): Promise<number> {
  const linhas = await query<{ id: string }>(
    `UPDATE lots SET status = 'encerrado', closed_reason = 'prazo', closed_at = now()
      WHERE status IN ('aberto','agendado') AND ${VENCIDO}
      RETURNING id`,
  );
  return linhas.length;
}

/**
 * DESLIGADA. Ausência na listagem NÃO é evidência de encerramento.
 *
 * Medido em 2026-09-16 com `scripts/poc-encerramento.mjs`, amostra de 25 lotes
 * do soleon que esta regra fecharia: **19 estavam vivos** (16 com o leilão ainda
 * por abrir, "Aguarde Abertura", e 3 abertos para lance). Só 5 estavam
 * encerrados. A regra erraria 3 em cada 4.
 *
 * A causa: a rota global que o conector varre (`/lotes/veiculo`) lista leilão em
 * ANDAMENTO. Lote de leilão que ainda não abriu não aparece nela e, para esta
 * regra, era indistinguível de lote que sumiu por ter encerrado.
 *
 * Fica aqui, desligada e com o motivo, porque o erro é atraente: a regra parece
 * óbvia e o dano seria invisível — lote vivo sumindo da busca sem nenhum sintoma.
 * O caminho certo é verificar a página do lote antes de fechar; a página
 * discrimina com precisão (`aguarde_abertura` / `aberto_lance` / `vendido`).
 */
const AUSENCIA_LIGADA = process.env.ENCERRAR_POR_AUSENCIA === '1';

async function encerrarPorAusencia(): Promise<number> {
  if (!AUSENCIA_LIGADA) return 0;
  const linhas = await query<{ id: string }>(
    `WITH varreduras AS (
       -- As N varreduras COMPLETAS mais recentes de cada fonte. O refresh quente
       -- também grava job='collect', e contá-lo aqui encerraria lote que a
       -- varredura parcial simplesmente não tinha por que visitar.
       SELECT source_id, started_at,
              row_number() OVER (PARTITION BY source_id ORDER BY started_at DESC) AS n
         FROM collection_runs
        WHERE job IN ('collect','collect:cli') AND ok AND limite >= $2
     ),
     corte AS (
       SELECT source_id, min(started_at) AS desde
         FROM varreduras WHERE n <= $1
        GROUP BY source_id
       -- Só corta quem de fato acumulou as N varreduras: fonte nova ou que
       -- acabou de voltar não tem histórico para afirmar ausência.
       HAVING count(*) = $1
     )
     UPDATE lots l SET status = 'encerrado', closed_reason = 'ausente_na_fonte', closed_at = now()
       FROM corte c
      WHERE l.source_id = c.source_id
        AND l.status IN ('aberto','agendado')
        AND l.collected_at < c.desde
      RETURNING l.id`,
    [CICLOS_PARA_AUSENCIA, LIMITE_DE_VARREDURA],
  );
  return linhas.length;
}

/**
 * Verifica na origem os candidatos a encerramento e fecha só os confirmados.
 *
 * O candidato vem da ausência na varredura; quem decide é a fonte. Lote que a
 * origem diz vivo ganha `verified_at` e sai da fila por um tempo — não é
 * reconsultado a cada ciclo, senão a fila nunca esvazia e o tráfego vira
 * constante contra os mesmos hosts.
 *
 * Hosts em paralelo, cadência dentro do host a cargo do verificador (gapMs).
 * Medido: latência p50 819ms, então o ritmo real é ~1,9s por requisição por
 * host — estimativa feita com 1 req/s subestima o tempo pela metade.
 */
export async function verificarCandidatos(teto = Number(process.env.VERIFICAR_POR_CICLO ?? 300)) {
  const fontes = Object.keys(VERIFICADORES);
  if (!fontes.length) return { verificados: 0, encerrados: 0, vivos: 0, indeterminados: 0 };

  const candidatos = await query<{ id: string; source_id: string; external_id: string | null; lot_url: string | null }>(
    `WITH ult AS (
       SELECT source_id, max(started_at) u FROM collection_runs
        WHERE job IN ('collect','collect:cli') AND ok AND limite >= $2 GROUP BY 1)
     SELECT l.id, l.source_id, l.external_id, l.lot_url
       FROM lots l JOIN ult ON ult.source_id = l.source_id
      WHERE l.source_id = ANY($1)
        AND l.status IN ('aberto','agendado')
        AND l.collected_at < ult.u
        -- Recuo: quem a origem já disse vivo espera; quem não deu para decidir
        -- espera mais a cada tentativa frustrada, até parar de ser reconsultado.
        AND (l.verified_at IS NULL
             OR l.verified_at < now() - (interval '6 hours' * GREATEST(1, l.verify_fails)))
      ORDER BY l.verified_at NULLS FIRST, random()
      LIMIT $3`,
    [fontes, LIMITE_DE_VARREDURA, teto],
  );
  if (!candidatos.length) return { verificados: 0, encerrados: 0, vivos: 0, indeterminados: 0 };

  const porHost = new Map<string, { fonte: string; lotes: LoteParaVerificar[] }>();
  for (const c of candidatos) {
    let host = '';
    try {
      host = new URL(c.lot_url ?? '').host;
    } catch {
      host = `(sem-url)-${c.source_id}`;
    }
    const grupo = porHost.get(host) ?? { fonte: c.source_id, lotes: [] };
    grupo.lotes.push({ id: Number(c.id), externalId: c.external_id, lotUrl: c.lot_url });
    porHost.set(host, grupo);
  }

  const vereditos: Array<{ id: number; veredito: Veredito; sinal: string }> = [];
  await Promise.all(
    [...porHost.entries()].map(async ([host, { fonte, lotes }]) => {
      if (!temVerificador(fonte)) return;
      try {
        const r = await VERIFICADORES[fonte].verificar(host, lotes);
        for (const [id, res] of r) vereditos.push({ id, ...res });
      } catch (e: any) {
        for (const l of lotes) vereditos.push({ id: l.id, veredito: 'indeterminado', sinal: String(e.message).slice(0, 50) });
      }
    }),
  );

  const mortos = vereditos.filter((v) => v.veredito === 'encerrado' || v.veredito === 'sumiu');
  const vivos = vereditos.filter((v) => v.veredito === 'aberto' || v.veredito === 'agendado');
  const cegos = vereditos.filter((v) => v.veredito === 'indeterminado');

  if (mortos.length) {
    await query(
      `UPDATE lots SET status='encerrado', closed_reason='verificado_na_fonte', closed_at=now(),
              verified_at=now(), verify_result=d.sinal, verify_fails=0
         FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) sinal) d
        WHERE lots.id = d.id`,
      [mortos.map((m) => m.id), mortos.map((m) => m.sinal.slice(0, 120))],
    );
  }
  if (vivos.length) {
    await query(
      `UPDATE lots SET verified_at=now(), verify_result=d.sinal, verify_fails=0
         FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) sinal) d
        WHERE lots.id = d.id`,
      [vivos.map((m) => m.id), vivos.map((m) => m.sinal.slice(0, 120))],
    );
  }
  if (cegos.length) {
    await query(
      `UPDATE lots SET verified_at=now(), verify_result=d.sinal, verify_fails=verify_fails+1
         FROM (SELECT unnest($1::bigint[]) id, unnest($2::text[]) sinal) d
        WHERE lots.id = d.id`,
      [cegos.map((m) => m.id), cegos.map((m) => m.sinal.slice(0, 120))],
    );
  }
  return { verificados: vereditos.length, encerrados: mortos.length, vivos: vivos.length, indeterminados: cegos.length };
}

export async function encerrarLotes(): Promise<ResultadoEncerramento> {
  return { porPrazo: await encerrarPorPrazo(), porAusencia: await encerrarPorAusencia() };
}

export const ausenciaLigada = () => AUSENCIA_LIGADA;
