import { query } from './db.js';
import { VENCIDO } from './encerramento.js';
import { parseQuery, fold } from './normalize.js';

/**
 * Casamento de alertas.
 *
 * Roda contra os lotes que ACABARAM de entrar, não contra o índice inteiro:
 * o gatilho é a ingestão. Reaproveita o mesmo `parseQuery` da busca, então
 * "volkswagen taos" vira marca + modelo estruturados e o alerta não dispara
 * por causa de um "taos" solto no meio de outra descrição.
 */

export interface Alerta {
  id: number;
  owner_id: number;
  created_at: string;
  label: string;
  q: string | null;
  filters: Record<string, any>;
  channels: string[];
  email: string | null;
}

export interface Disparo {
  alertId: number;
  /** Dono do alerta. O push precisa dele: sem isso o alerta de um usuário
   *  notificava o celular de todos os outros. */
  ownerId: number;
  label: string;
  channels: string[];
  email: string | null;
  lotId: number;
  title: string;
  lotUrl: string | null;
  bid: number | null;
  source: string;
}

/** Predicado SQL do alerta, no mesmo vocabulário da busca. */
/**
 * `base` é quantos parâmetros a consulta já usou antes destes. Era uma
 * constante embutida (`+ 1`, quando só a lista de ids vinha antes), e passou a
 * ser argumento quando a data de criação do alerta virou o $2: deixar fixo
 * faria o WHERE apontar para o parâmetro errado — em silêncio, porque os tipos
 * casariam e o Postgres não reclamaria.
 */
function condicoes(a: Alerta, base: number): { sql: string[]; params: any[] } {
  const sql: string[] = [];
  const params: any[] = [];
  const ph = (v: any) => {
    params.push(v);
    return `$${params.length + base}`;
  };

  const p = parseQuery(a.q ?? '');

  // A busca é estrita de propósito (marca e modelo como igualdade), mas para
  // alerta PERDER um lote é pior do que trazer um a mais: se o conector falhou
  // em extrair marca/modelo, a linha fica NULL e o casamento estrutural não pega.
  // Então aceita também o texto contendo marca E modelo juntos — exigir os dois
  // é o que mantém "mercedes b 200" longe de um GLA.
  // `\y` é fronteira de palavra no Postgres. LIKE '%taos%' casava dentro de
  // "sertaosantana" — o search_text guarda pares de palavras COLADOS (para
  // "t cross" achar "tcross"), e isso fabrica substring que não existe no texto.
  const porPalavra = (termo: string) => `search_text ~ ${ph(`\\y${fold(termo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\y`)}`;

  if (p.brand && p.model) {
    sql.push(`((brand = ${ph(p.brand)} AND model = ${ph(p.model)}) OR (${porPalavra(p.brand)} AND ${porPalavra(p.model)}))`);
  } else if (p.brand) {
    sql.push(`(brand = ${ph(p.brand)} OR ${porPalavra(p.brand)})`);
  } else if (p.model) {
    sql.push(`(model = ${ph(p.model)} OR ${porPalavra(p.model)})`);
  }
  for (const t of p.freeTerms) sql.push(`search_text LIKE ${ph(`%${t}%`)}`);
  if (!p.brand && !p.model && !p.freeTerms.length && p.compactTerm) {
    sql.push(`search_text LIKE ${ph(`%${p.compactTerm}%`)}`);
  }

  const f = a.filters ?? {};
  if (f.assetType) sql.push(`asset_type = ${ph(f.assetType)}`);

  /**
   * Todo filtro de lista da tela chega como "carro,suv,picape". Comparar com
   * igualdade nunca casa e o alerta fica MUDO sem erro nenhum — foi exatamente
   * assim que o alerta de Kardian não disparou: o lote era 'suv', estava na
   * lista, e a condição virava `vehicle_type = 'carro,suv,picape'`.
   * Agora que Estado, Fonte, Origem e Leiloeiro também são multi-seleção,
   * a regra tem de valer para todos, não só para tipo de veículo.
   */
  const emLista = (col: string, v: unknown, mapa?: (x: string) => string) => {
    const vals = (Array.isArray(v) ? v : String(v ?? '').split(','))
      .map((x) => String(x).trim())
      .filter(Boolean)
      .map((x) => (mapa ? mapa(x) : x));
    if (vals.length === 1) sql.push(`${col} = ${ph(vals[0])}`);
    else if (vals.length > 1) sql.push(`${col} = ANY(${ph(vals)})`);
    return vals;
  };

  emLista('vehicle_type', f.vehicleType);
  emLista('state', f.uf, (x) => x.toUpperCase());
  emLista('source_id', f.sourceId);
  emLista('seller_type', f.sellerType);
  emLista('auctioneer_name', f.auctioneer);
  if (f.priceMin != null) sql.push(`COALESCE(current_bid, min_bid) >= ${ph(Number(f.priceMin))}`);
  if (f.priceMax != null) sql.push(`COALESCE(current_bid, min_bid) <= ${ph(Number(f.priceMax))}`);
  if (f.yearMin != null) sql.push(`year_model >= ${ph(Number(f.yearMin))}`);
  if (f.yearMax != null) sql.push(`year_model <= ${ph(Number(f.yearMax))}`);
  if (f.onlyWithPhoto) sql.push('photo_count > 0');

  // Lote fora do escopo (peça, lote misto) nunca dispara alerta.
  sql.push(`asset_type <> 'outro'`);
  return { sql, params };
}

/** Avalia os alertas ativos contra um conjunto de ids recém-gravados. */
/**
 * Quantos lotes ATIVOS do índice casariam com este alerta hoje.
 *
 * É só informação para a confirmação da criação ("3 lotes no índice já casam"),
 * e de propósito NÃO grava disparo: o alerta avisa do que entra a partir de
 * agora. Antes, a criação varria 7 dias para trás e gravava hit de tudo que
 * achava — um alerta criado às 3h da manhã nascia com três lotes que estavam na
 * base havia 12 horas.
 */
export async function contarCasaveis(a: Alerta): Promise<number> {
  const { sql, params } = condicoes(a, 0);
  const where = sql.length ? `AND ${sql.join(' AND ')}` : '';
  const [r] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM lots
      WHERE status NOT IN ('encerrado','vendido') AND NOT ${VENCIDO} ${where}`,
    params,
  );
  return r?.n ?? 0;
}

export async function avaliarAlertas(lotIds: number[]): Promise<Disparo[]> {
  if (!lotIds.length) return [];
  const alertas = await query<Alerta>(
    `SELECT id, owner_id, created_at, label, q, filters, channels, email FROM alerts WHERE enabled ORDER BY id`,
  );
  const disparos: Disparo[] = [];

  for (const a of alertas) {
    // $1 = lista de ids, $2 = created_at do alerta. Os do alerta vêm a partir do $3.
    const { sql, params } = condicoes(a, 2);
    const where = sql.length ? `AND ${sql.join(' AND ')}` : '';
    /**
     * Duas condições que não estavam aqui e o usuário sentiu as duas:
     *
     * 1. `first_seen_at >= a.created_at` — alerta avisa do que ENTRA depois
     *    dele, nunca do passado. Sem isto, criar um alerta às 03:45 disparava
     *    na mesma hora por lotes que estavam na base havia 12 horas.
     *
     * 2. `NOT VENCIDO` e status aberto — avisar sobre lote encerrado é convidar
     *    para um leilão que já passou. A mesma expressão da busca, importada,
     *    porque duas cópias da regra de vencimento divergiriam.
     *
     * Ambas moram no CASAMENTO, não só em quem chama: é o único ponto por onde
     * todo disparo passa, venha da coleta ou de qualquer outro gatilho.
     */
    const achados = await query<any>(
      `SELECT id, title_raw, lot_url, source_id, COALESCE(current_bid, min_bid) AS bid
         FROM lots
        WHERE id = ANY($1::bigint[])
          AND first_seen_at >= $2::timestamptz
          AND status NOT IN ('encerrado','vendido')
          AND NOT ${VENCIDO}
          ${where}
        LIMIT 50`,
      [lotIds, a.created_at, ...params],
    );

    for (const l of achados) {
      // O UNIQUE (alert_id, lot_id) é o que garante um aviso por lote; o
      // ON CONFLICT DO NOTHING devolve zero linhas quando já avisamos antes.
      const [ins] = await query<{ id: string }>(
        `INSERT INTO alert_hits (alert_id, lot_id) VALUES ($1,$2)
         ON CONFLICT (alert_id, lot_id) DO NOTHING RETURNING id`,
        [a.id, l.id],
      );
      if (!ins) continue;
      disparos.push({
        alertId: a.id,
        ownerId: Number(a.owner_id),
        label: a.label,
        channels: a.channels,
        email: a.email,
        lotId: Number(l.id),
        title: l.title_raw,
        lotUrl: l.lot_url,
        bid: l.bid,
        source: l.source_id,
      });
    }
    await query('UPDATE alerts SET last_run_at = now() WHERE id = $1', [a.id]);
  }
  return disparos;
}

export async function marcarNotificado(alertId: number, lotId: number, canal: string) {
  await query(
    `UPDATE alert_hits SET notified = array_append(notified, $3)
      WHERE alert_id=$1 AND lot_id=$2 AND NOT ($3 = ANY(notified))`,
    [alertId, lotId, canal],
  );
}
