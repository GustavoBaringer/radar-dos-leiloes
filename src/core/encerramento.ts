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
 * Fecha o que a fonte parou de devolver.
 *
 * É o único caminho para os lotes sem data nenhuma — soleon publica 958 assim,
 * e o conector grava as duas datas como NULL incondicionalmente. Nenhum relógio
 * alcança esses: só a ausência na origem.
 *
 * O corte é por CICLO DE VARREDURA, não por horas fixas. Fonte que ficou fora do
 * ar não pode encerrar o catálogo inteiro dela só porque o tempo passou — sem
 * varredura bem-sucedida não há evidência de ausência, e o lote fica como está.
 */
async function encerrarPorAusencia(): Promise<number> {
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

export async function encerrarLotes(): Promise<ResultadoEncerramento> {
  return { porPrazo: await encerrarPorPrazo(), porAusencia: await encerrarPorAusencia() };
}
