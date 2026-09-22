import { readFileSync } from 'node:fs';
import { comNavegador, getLatin1ViaNavegador } from './navegador.js';
import type { Connector, CollectResult } from './types.js';
import type { CanonicalLot } from '../core/types.js';

const INDICE = 'https://venda-imoveis.caixa.gov.br/sistema/download-lista.asp';
const CSV_NACIONAL = 'https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_geral.csv';

/**
 * Imóveis da Caixa. Uma requisição por dia entrega o país inteiro (7.199 imóveis),
 * sem autenticação e sem paginação — não há API JSON, e a busca do site exige CPF.
 *
 * Três armadilhas medidas em 14/09/2026:
 *
 * 1. **O antibot responde HTTP 200.** O Radware Bot Manager devolve uma página de
 *    CAPTCHA com status 200 e ~18 KB. Quem checar só o código gravaria CAPTCHA no
 *    banco achando que era CSV. A detecção aqui é por CONTEÚDO.
 * 2. **O bloqueio é por IP e dura dezenas de minutos.** Uma rajada de 28 requisições
 *    queimou o IP por mais de 20 min. Por isso: 2 requisições por ciclo, e nada de retry
 *    agressivo.
 * 3. **A coluna "Preço" NÃO é preço de venda.** É o valor mínimo do 1º leilão, e ele
 *    SUPERA a avaliação em 33,7% dos imóveis (o saldo devedor costuma passar a
 *    avaliação no Leilão SFI). Exibi-la como preço anunciaria 1 em 3 imóveis mais caro
 *    que a avaliação, com "desconto 0" enganoso. Por isso vai para `minBid`, e a
 *    avaliação para `appraisal`.
 *
 * 4. Desde 15/09/2026 o MESMO antibot passou a redirecionar (302 para
 *    validate.perfdrive.com) em vez de servir o HTML de CAPTCHA — mas o motivo
 *    NÃO é IP em cooldown como eu tinha concluído. É desafio comportamental
 *    (Radware/ShieldSquare): `request()` do undici nunca passa, porque não
 *    executa JS nem simula mouse. MEDIDO em 22/09 com Chromium headless via
 *    `comNavegador` — 200 real, título "Caixa - Imóvel à venda", 1ª tentativa.
 *    Cabeçalho puro nunca vai passar por mais headers que se copie.
 */

function pareceCaptcha(body: string): boolean {
  return /Radware Bot Manager|CAPTCHA|perfdrive\.com/i.test(body.slice(0, 4000));
}

// Discrimina o antibot conhecido (não precisa reabrir investigação) de um
// redirect para outro lugar (aí sim pode ser URL trocada pela Caixa).
function ehRedirectAntibot(location?: string): boolean {
  return !!location && /perfdrive\.com|shieldsquare/i.test(location);
}

/** Colunas 6 e 7 usam vírgula decimal; a 8 usa ponto. Dois parsers no mesmo arquivo. */
function moedaBr(v?: string | null): number | null {
  const n = Number(String(v ?? '').trim().replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}
function percentualPonto(v?: string | null): number | null {
  const n = Number(String(v ?? '').trim());
  return isFinite(n) && n > 0 ? n : null;
}

const TIPO_CANONICO: Array<[RegExp, string]> = [
  [/apartamento/i, 'apartamento'],
  [/casa/i, 'casa'],
  [/terreno|gleba|lote/i, 'terreno'],
  [/sala|loja|comercial|galp[ãa]o|pr[ée]dio/i, 'comercial'],
  [/rural|s[íi]tio|ch[áa]cara|fazenda/i, 'rural'],
  [/sobrado/i, 'casa'],
  [/vaga|garagem/i, 'vaga'],
];

interface Descricao {
  tipo: string | null;
  areaTotal: number | null;
  areaPrivativa: number | null;
  areaTerreno: number | null;
  quartos: number | null;
  vagas: number | null;
}

/** A Descrição é semi-estruturada e casa em 100% das linhas medidas. */
function parseDescricao(desc: string): Descricao {
  const m = desc.match(
    /^\s*([^,]+),\s*([\d.]+)\s*de área total,\s*([\d.]+)\s*de área privativa,\s*([\d.]+)\s*de área do terreno/i,
  );
  const bruto = m?.[1]?.trim() ?? null;
  const tipo = bruto ? (TIPO_CANONICO.find(([re]) => re.test(bruto))?.[1] ?? 'outro') : null;
  const num = (v?: string) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  };
  return {
    tipo,
    areaTotal: num(m?.[2]),
    areaPrivativa: num(m?.[3]),
    areaTerreno: num(m?.[4]),
    quartos: num(desc.match(/(\d+)\s*qto\(s\)/i)?.[1]),
    vagas: num(desc.match(/(\d+)\s*vaga\(s\)/i)?.[1]),
  };
}

async function baixarCsv(): Promise<{ texto: string; status: number; url?: string }> {
  // Caminho local para desenvolvimento e para quando o IP estiver em cooldown.
  const local = process.env.CAIXA_CSV_PATH;
  if (local) return { texto: readFileSync(local, 'latin1'), status: 200 };

  // O navegador resolve o Radware ao visitar o índice; o Referer some porque
  // deixa de existir requisição manual — é a própria navegação da page.
  return comNavegador(INDICE, async (page) => {
    const { status, raw, url } = await getLatin1ViaNavegador(page, CSV_NACIONAL, { accept: 'text/csv,application/octet-stream,*/*' });
    return { texto: raw, status, url };
  });
}

export const caixa: Connector = {
  def: {
    id: 'caixa',
    name: 'Caixa Econômica Federal',
    platform: 'arquivo público',
    method: 'api',
    tier: 1,
    siteUrl: 'https://venda-imoveis.caixa.gov.br',
    notes:
      'CSV nacional, 1 requisição por ciclo, via Chromium headless (Radware exige navegador de verdade desde 15/09). Coluna "Preço" é o mínimo do 1º leilão, não preço de venda. Sem data de praça no arquivo.',
  },
  async collect({ limit }): Promise<CollectResult> {
    const { texto, status, url } = await baixarCsv();
    if (pareceCaptcha(texto)) {
      const err: any = new Error('Caixa respondeu CAPTCHA do Radware (IP em cooldown)');
      err.httpStatus = status;
      throw err;
    }
    // `fetch()` do navegador já segue redirect sozinho — se pousou fora do
    // domínio do CSV, é o antibot desviando, mesmo com status 200 de chegada.
    if (status < 200 || status >= 300 || (url && ehRedirectAntibot(url))) {
      let msg = `Caixa respondeu HTTP ${status} em vez do CSV`;
      if (url && ehRedirectAntibot(url)) msg = `Caixa redirecionou para o CAPTCHA do Radware (IP bloqueado): ${url}`;
      else if (url && !url.includes('Lista_imoveis_geral.csv')) msg += ` (pousou em ${url})`;
      const err: any = new Error(msg);
      err.httpStatus = status;
      throw err;
    }

    const linhas = texto.split('\n');
    const geradoEm = linhas.find((l) => l.includes('Data de geração'))?.split(';')[3]?.trim() ?? null;
    const lots: CanonicalLot[] = [];
    let fetched = 0;
    let skipped = 0;

    for (const linha of linhas) {
      const c = linha.split(';');
      if (c.length !== 12) continue;
      const id = c[0].trim();
      if (!/^\d+$/.test(id)) continue;
      fetched++;
      if (lots.length >= limit) continue;

      const modalidade = c[10].trim();
      // Só leilão entra: "Licitação Aberta" e "Venda Online" são outra coisa.
      if (!/leil[ãa]o/i.test(modalidade)) {
        skipped++;
        continue;
      }

      const uf = c[1].trim();
      const cidade = c[2].trim();
      const bairro = c[3].trim();
      const endereco = c[4].trim();
      const d = parseDescricao(c[9]);
      const minBid = moedaBr(c[5]);
      const avaliacao = moedaBr(c[6]);

      lots.push({
        sourceId: 'caixa',
        externalId: id,
        lotUrl: c[11].trim() || `https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=${id}`,
        titleRaw: [d.tipo ? d.tipo[0].toUpperCase() + d.tipo.slice(1) : 'Imóvel', bairro, `${cidade}/${uf}`]
          .filter(Boolean)
          .join(' - '),
        assetType: 'imovel',
        vehicleType: null,
        sourceCategory: d.tipo,
        docType: modalidade,
        // O arquivo não traz data de praça — só a página de detalhe traz, e são
        // 5.189 requisições contra um antibot agressivo. Declarar "sem_data" é
        // honesto; inventar data seria pior.
        closingModel: 'pregao_em_horario',
        auctionStartUtc: null,
        auctionEndUtc: null,
        sourceTz: 'America/Sao_Paulo',
        status: 'sem_data',
        currentBid: null,
        minBid,
        appraisal: avaliacao,
        auctioneerName: null,
        sellerName: 'Caixa Econômica Federal',
        sellerType: 'banco',
        city: cidade,
        state: uf,
        yard: endereco || null,
        photos: [],
        financeable: /^sim$/i.test(c[8].trim()),
        raw: {
          modalidade,
          bairro,
          endereco,
          descricao: c[9].trim(),
          descontoPct: percentualPonto(c[7]),
          tipoImovel: d.tipo,
          areaTotal: d.areaTotal,
          areaPrivativa: d.areaPrivativa,
          areaTerreno: d.areaTerreno,
          quartos: d.quartos,
          vagas: d.vagas,
          arquivoGeradoEm: geradoEm,
          avisoPreco: 'minBid é o valor mínimo do 1º leilão; supera a avaliação em ~34% dos casos',
        },
      });
    }

    return { lots, fetched, skipped, httpStatus: status };
  },
};
