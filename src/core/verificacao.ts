/**
 * Verificação do lote na origem.
 *
 * Existe porque ausência na nossa varredura NÃO é evidência de encerramento.
 * Medido em 25 lotes do soleon que a regra de ausência fecharia: 19 estavam
 * vivos (16 com o leilão ainda por abrir, 3 abertos para lance). A ausência
 * mede a cobertura da nossa varredura — e as três fontes falham por motivos
 * diferentes. Então a ausência PROPÕE o candidato e a origem DECIDE.
 *
 * O verificador recebe os lotes agrupados POR HOST porque o custo muda de fonte
 * para fonte: no soleon é uma requisição por lote (a página de detalhe), no
 * vlance uma requisição devolve o catálogo inteiro daquele host. Achatar isso
 * numa chamada por lote multiplicaria por 200 o tráfego contra o vlance.
 */
import { fetchText, fetchJson } from '../connectors/http.js';

export type Veredito = 'aberto' | 'agendado' | 'encerrado' | 'sumiu' | 'indeterminado';

export interface LoteParaVerificar {
  id: number;
  externalId: string | null;
  lotUrl: string | null;
}
export interface Resultado {
  veredito: Veredito;
  sinal: string;
}
export interface Verificador {
  /** Uma requisição por lote, ou uma por host? Decide o tamanho do lote enviado. */
  porHost: boolean;
  verificar(host: string, lotes: LoteParaVerificar[]): Promise<Map<number, Resultado>>;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * SOLEON — a página do lote traz o estado num marcador estável:
 *   <div id="status_lote"><div class="label_lote aberto_lance">Aberto para Lances</div>
 *
 * Os rótulos medidos em campo: `aberto_lance`, `aguarde_abertura` (leilão ainda
 * não começou — VIVO, e era esse o caso que derrubava a regra antiga) e
 * `vendido`. Qualquer classe nova cai em indeterminado de propósito: inventar
 * significado para rótulo desconhecido é como se fecha lote vivo.
 */
const soleon: Verificador = {
  porHost: false,
  async verificar(_host, lotes) {
    const saida = new Map<number, Resultado>();
    for (const l of lotes) {
      if (!l.lotUrl) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: 'sem URL' });
        continue;
      }
      try {
        const r = await fetchText(l.lotUrl, { headers: { 'user-agent': UA }, gapMs: 1100, timeoutMs: 25000 });
        if (r.status === 404 || r.status === 410) {
          saida.set(l.id, { veredito: 'sumiu', sinal: `HTTP ${r.status}` });
          continue;
        }
        if (r.status !== 200) {
          saida.set(l.id, { veredito: 'indeterminado', sinal: `HTTP ${r.status}` });
          continue;
        }
        const m = /id="status_lote"[\s\S]{0,400}?class="label_lote ([a-z_]+)"[^>]*>([^<]*)</i.exec(r.body);
        if (!m) {
          // Segundo template (medido no amaralleiloes): sem #status_lote, o
          // estado vem como <div class="...btn-block"><strong>ENCERRADO</strong>.
          // Só a palavra explícita fecha — a AUSÊNCIA dela NÃO vira "aberto",
          // porque não achei lote aberto neste template para comparar, e inferir
          // estado a partir da falta de marcador é como se apaga lote vivo.
          const alt = /<div[^>]*btn-block[^>]*>\s*<strong>\s*(ENCERRADO|ARREMATADO|VENDIDO|CANCELADO)\s*<\/strong>/i.exec(r.body);
          if (alt) saida.set(l.id, { veredito: 'encerrado', sinal: alt[1].toUpperCase() });
          else saida.set(l.id, { veredito: 'indeterminado', sinal: 'sem marcador de status' });
          continue;
        }
        const classe = m[1].toLowerCase();
        const texto = m[2].trim();
        if (/aberto/.test(classe)) saida.set(l.id, { veredito: 'aberto', sinal: texto });
        else if (/aguard/.test(classe)) saida.set(l.id, { veredito: 'agendado', sinal: texto });
        else if (/encerrad|sustad|arrematad|vendid|cancelad|suspens|deserto|retirad/.test(classe)) {
          saida.set(l.id, { veredito: 'encerrado', sinal: texto });
        } else {
          // Rótulos vistos em campo e ainda NÃO decididos: `condicional` (venda
          // sujeita a aprovação do comitente) e `sem_licitante` (pregão sem
          // lance). Os dois provavelmente significam pregão encerrado, mas não
          // medi. Tentei usar "a página tem controle de lance?" como sinal e o
          // controle derrubou: um lote aberto deu false e um "Aguarde Abertura"
          // deu true. Sem evidência, ficam indeterminados e aparecem no log.
          saida.set(l.id, { veredito: 'indeterminado', sinal: `${classe}: ${texto}` });
        }
      } catch (e: any) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: String(e.message).slice(0, 50) });
      }
    }
    return saida;
  },
};

/**
 * VLANCE — a API do host devolve o catálogo inteiro com `nm_statuslote`, então
 * UMA requisição resolve todos os lotes daquele host.
 *
 * Medido: a API NÃO devolve lote encerrado — ela lista só o que está ativo.
 * Logo o veredito se lê ao contrário do soleon: presente = vivo, ausente da
 * resposta = encerrado. E é por isso que a resposta precisa ter vindo íntegra:
 * uma falha de rede devolveria lista vazia e "encerraria" o host inteiro.
 */
const vlance: Verificador = {
  porHost: true,
  async verificar(host, lotes) {
    const saida = new Map<number, Resultado>();
    const vivos = new Map<string, string>();
    let respondeu = false;
    // Todos os tipos, não só os que o conector ingere: a pergunta aqui é se o
    // lote continua no catálogo ativo, e há lote vivo em tipo 2 e 4.
    for (const tipo of [1, 2, 3, 4]) {
      try {
        const r = await fetchJson<any>(`https://${host}/core/api/get-lotes?tipo=${tipo}&qtd_por_pagina=5000`, {
          method: 'POST',
          gapMs: 900,
          timeoutMs: 45000,
        });
        if (r.status !== 200 || !Array.isArray(r.data?.items)) continue;
        respondeu = true;
        for (const it of r.data.items) vivos.set(String(it.lote_id), String(it.nm_statuslote ?? 'ativo'));
      } catch {
        /* um tipo que falhou não invalida o outro; `respondeu` guarda o resto */
      }
    }
    for (const l of lotes) {
      if (!respondeu) {
        // Sem resposta boa não se conclui nada. Tratar silêncio como encerramento
        // apagaria o catálogo inteiro de um host que ficou fora do ar.
        saida.set(l.id, { veredito: 'indeterminado', sinal: 'API do host não respondeu' });
        continue;
      }
      const idLote = String(l.lotUrl?.match(/\/lote\/(\d+)/)?.[1] ?? '');
      if (!idLote) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: 'sem id de lote na URL' });
        continue;
      }
      const st = vivos.get(idLote);
      if (st) saida.set(l.id, { veredito: /encerr|vendid|arremat/i.test(st) ? 'encerrado' : 'aberto', sinal: st });
      else saida.set(l.id, { veredito: 'encerrado', sinal: 'ausente do catálogo ativo da API' });
    }
    return saida;
  },
};

/**
 * LEILO — sem verificador.
 *
 * A página do lote é SPA: responde 200 e desenha o conteúdo no cliente,
 * inclusive o "não encontrado". Medido em 47 lotes, 47 indeterminados. A API de
 * busca existe, mas o filtro por id não funciona (`campo:"id"` devolve lista
 * vazia até para lote comprovadamente ativo). Enquanto não houver caminho, o
 * lote do leilo NÃO é encerrado por este mecanismo — preferir lote a mais na
 * busca a lote vivo apagado em silêncio.
 */
export const VERIFICADORES: Record<string, Verificador> = { soleon, vlance };

export const temVerificador = (fonte: string) => fonte in VERIFICADORES;
