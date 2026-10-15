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
import { fetchText, fetchJson } from '../../connectors/http.js';
import {
  soleonResposta, vlanceResposta, leiloResposta, freitasResposta, hastapublicaResposta,
  type LoteParaVerificar, type Resultado, type Veredito, type Verificador,
} from '../../domain/lots/verification.js';
export type { LoteParaVerificar, Resultado, Veredito, Verificador } from '../../domain/lots/verification.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/**
 * Todas as datas de praça anunciadas na página, mais recente primeiro.
 *
 * Separa "lote sem lance e acabou" de "lote sem lance na 1ª praça que reabre
 * na 2ª" — leilão judicial no Brasil tem duas praças por lei (CPC 891), e a
 * segunda usa a mesma URL e o mesmo id.
 */
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
        saida.set(l.id, soleonResposta(l, r.status, r.body, Date.now));
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
        // Mantém a fronteira histórica por tipo: um item inválido descarta somente
        // o restante desse catálogo, sem invalidar os tipos já processados.
        for (const it of r.data.items) vivos.set(String(it.lote_id), String(it.nm_statuslote ?? 'ativo'));
      } catch {
        /* falha de tipo/item não invalida os tipos anteriores */
      }
    }
    return vlanceResposta(lotes, respondeu, vivos);
  },
};

/**
 * LEILO — varredura completa por categoria.
 *
 * A página é SPA e não serve: 47 de 47 lotes deram indeterminado no HTML cru.
 * E o filtro por id da API é instável — medido, `campo:"lelId"` devolveu
 * `count:0` para 2 de 5 lotes comprovadamente ATIVOS. Filtro pontual não pode
 * ser veredito.
 *
 * O que funciona é a mesma lógica do vlance: a `busca-elastic` devolve SÓ lote
 * ativo. Medido nas seis categorias (535 itens): `dataFim` no passado = ZERO em
 * todas elas, e `situacao` só aparece como `LiberadoLeilao` ou `AoVivo`. Logo,
 * presente na varredura = vivo; ausente = encerrado.
 *
 * Todos os lotes do leilo saem do mesmo host, então `porHost: true` junta o
 * conjunto inteiro e seis varreduras respondem por todos de uma vez.
 */
const CATEGORIAS_LEILO = ['Carros', 'Motos', 'Utilitarios', 'Sucatas', 'Pesados', 'Equipamentos'];
const PAGINA_LEILO = 200;

const leilo: Verificador = {
  porHost: true,
  async verificar(_host, lotes) {
    const saida = new Map<number, Resultado>();
    const vivos = new Set<string>();
    /** Categorias varridas até o fim. Só nelas a ausência significa alguma coisa. */
    const completas = new Set<string>();

    for (const cat of CATEGORIAS_LEILO) {
      let ok = true;
      let itensNaCategoria = 0;
      for (let from = 0; from < 5000; from += PAGINA_LEILO) {
        let r;
        try {
          r = await fetchJson<any>('https://api.leilo.com.br/v1/lote/busca-elastic', {
            method: 'POST',
            gapMs: 1100,
            timeoutMs: 40000,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              from,
              size: PAGINA_LEILO,
              requisicoesBusca: [{ campo: 'tipo', tipo: 'exata', valor: cat }],
            }),
          });
        } catch {
          ok = false;
          break;
        }
        const itens: any[] = r.status === 200 ? (Array.isArray(r.data) ? r.data : (r.data?.items ?? [])) : [];
        if (r.status !== 200 || !Array.isArray(itens)) {
          ok = false;
          break;
        }
        itensNaCategoria += itens.length;
        for (const it of itens) vivos.add(String(it.lelId ?? it.id));
        // Página incompleta = fim da categoria. É o sinal de que a varredura
        // chegou ao fim, e não de que a API cortou a resposta no meio.
        if (itens.length < PAGINA_LEILO) break;
      }
      // Categoria que devolveu ZERO é indistinguível de categoria que falhou.
      // Aceitar o vazio encerraria todos os lotes dela de uma vez — é o mesmo
      // erro de tratar silêncio como resposta.
      if (ok && itensNaCategoria > 0) completas.add(cat);
    }

    return leiloResposta(lotes, completas, vivos);
  },
};

/**
 * FREITAS — `RetornarLoteStatus` responde pelo lote, não pela listagem: com
 * `success:false` a fonte afirma que o lote não existe mais, o que é o sinal
 * POSITIVO de remoção que a ausência na varredura nunca dá.
 *
 * Existe porque o leilão em montagem ("EM LOTEAMENTO") renumera lotes: o 8048/604
 * saiu da listagem, ficou preso como `sem_data` — sem prazo, nenhuma regra de
 * relógio o alcançava — e a página dele devolvia 500 ao usuário.
 */
const freitas: Verificador = {
  porHost: false,
  async verificar(_host, lotes) {
    const saida = new Map<number, Resultado>();
    for (const l of lotes) {
      const m = /^(\d+)-(\d+)$/.exec(l.externalId ?? '');
      if (!m) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: 'externalId fora do formato leilao-lote' });
        continue;
      }
      try {
        const { status, data } = await fetchJson<{ success?: boolean; message?: any }>(
          `https://www.freitasleiloeiro.com.br/Leiloes/RetornarLoteStatus?leilaoId=${m[1]}&loteNumero=${m[2]}`,
          { insecureTls: true, gapMs: 1100, timeoutMs: 25000 },
        );
        saida.set(l.id, freitasResposta(l, status, data));
      } catch (e: any) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: `erro: ${e?.message ?? e}` });
      }
    }
    return saida;
  },
};

/**
 * HASTÁ PÚBLICA / VALLAND — o estado do lote está num par estável na página de
 * detalhe, que o conector (que só lê a home) nunca via:
 *
 *   <dt>Status do Item</dt><dd class="badge bg-success">Recebendo Propostas</dd>
 *   <dt>Encerra em</dt><dd class="destaquetexto">13/10/2026 14:01 <small>…</small></dd>
 *
 * Existe por causa do lote 104282 (Mercedes GLA 250, 13/10/2026): o card da
 * home publicava "Próxima data 13/10/2026 00:00" e o conector gravava isso como
 * FIM, encerrando o lote à meia-noite enquanto a origem escrevia "Encerra em
 * 13/10/2026 14:01" com status "Recebendo Propostas" — 14 horas de leilão ativo
 * dado por morto. Esta fonte não tinha verificador, então nada contestou.
 *
 * Por isso o verificado devolve também `fimUtc`: o prazo verdadeiro da origem,
 * que corrige o nosso quando existe.
 *
 * Rótulo desconhecido vira indeterminado, como nos outros: inventar estado a
 * partir de palavra não vista é como se fecha lote vivo.
 */
const hastapublica: Verificador = {
  porHost: false,
  async verificar(_host, lotes, buscar: typeof fetchText = fetchText) {
    const saida = new Map<number, Resultado>();
    for (const l of lotes) {
      if (!l.lotUrl) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: 'sem URL' });
        continue;
      }
      try {
        const r = await buscar(l.lotUrl, { headers: { 'user-agent': UA }, gapMs: 1100, timeoutMs: 25000 });
        saida.set(l.id, hastapublicaResposta(l, r.status, r.body, Date.now));
      } catch (e: any) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: String(e.message).slice(0, 50) });
      }
    }
    return saida;
  },
};

export const VERIFICADORES: Record<string, Verificador> = { soleon, vlance, leilo, freitas, hastapublica };

export const temVerificador = (fonte: string) => fonte in VERIFICADORES;
