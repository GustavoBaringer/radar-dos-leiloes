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
  /** Categoria da fonte. O verificador do leilo varre POR categoria e precisa
   *  saber em qual procurar cada lote — e qual delas ficou sem resposta. */
  categoria: string | null;
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
 * Todas as datas de praça anunciadas na página, mais recente primeiro.
 *
 * Separa "lote sem lance e acabou" de "lote sem lance na 1ª praça que reabre
 * na 2ª" — leilão judicial no Brasil tem duas praças por lei (CPC 891), e a
 * segunda usa a mesma URL e o mesmo id.
 */
function pracas(html: string): number[] {
  const t: number[] = [];
  for (const m of html.matchAll(/Data\s+\d?[ºo]?\s*Leil[ãa]o:?\s*<\/strong>?\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/gi)) {
    const [, d, mes, a, h = '23', min = '59'] = m;
    // Horário de Brasília (UTC-3) — a página publica local, sem fuso.
    const ts = Date.parse(`${a}-${mes}-${d}T${h}:${min}:00-03:00`);
    if (Number.isFinite(ts)) t.push(ts);
  }
  return t.sort((a, b) => b - a);
}

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
        } else if (/condicional/.test(classe)) {
          // Venda condicional: o lance já foi dado e falta só a aprovação do
          // comitente. O edital do leilão (lido na investigação) diz que a
          // comissão decide "de forma soberana e irrecorrível" e NÃO prevê
          // reoferta ao público — não há terceiro que possa dar lance enquanto
          // isso. Encerrado.
          saida.set(l.id, { veredito: 'encerrado', sinal: texto });
        } else if (/sem_licitante|nao_vendido/.test(classe)) {
          // "Sem Licitante" NÃO encerra sozinho. Contraexemplo medido: leilão
          // judicial de duas praças (CPC art. 891) — a 1ª praça não teve lance,
          // e o MESMO lote, na MESMA URL, reabre na 2ª com lance mínimo de 50%.
          // Fechá-lo perderia justamente a praça mais barata.
          const ps = pracas(r.body);
          saida.set(l.id, ps.some((t) => t > Date.now())
            ? { veredito: 'agendado', sinal: `${texto} (2ª praça marcada)` }
            : /<div[^>]*btn-block[^>]*>\s*<strong>\s*ENCERRADO\s*<\/strong>/i.test(r.body)
              ? { veredito: 'encerrado', sinal: `${texto} (sem praça futura)` }
              // A página nunca marca "ENCERRADO" explícito para este rótulo (medido
              // em infinityleiloes/1172), mas SE já sabemos a última praça e ela
              // passou, não sobra mecanismo de lance nenhum — encerrado por exaustão.
              : ps.length
                ? { veredito: 'encerrado', sinal: `${texto} (praças esgotadas, última em ${new Date(ps[0]).toISOString().slice(0, 10)})` }
                : { veredito: 'indeterminado', sinal: `${texto}: nenhuma data de praça encontrada` });
        } else {
          // Classe nova: indeterminado de propósito. Inventar significado para
          // rótulo desconhecido é como se fecha lote vivo.
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

    for (const l of lotes) {
      const cat = l.categoria ?? '';
      if (!completas.has(cat)) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: `categoria "${cat}" não varrida por completo` });
        continue;
      }
      const ext = String(l.externalId ?? '');
      saida.set(
        l.id,
        vivos.has(ext)
          ? { veredito: 'aberto', sinal: 'presente na varredura da categoria' }
          : { veredito: 'encerrado', sinal: 'ausente da varredura completa da categoria' },
      );
    }
    return saida;
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
        if (status !== 200 || !data) {
          saida.set(l.id, { veredito: 'indeterminado', sinal: `HTTP ${status}` });
          continue;
        }
        if (data.success === false) {
          saida.set(l.id, { veredito: 'sumiu', sinal: String(data.message ?? 'success:false') });
          continue;
        }
        const nome = String(data.message?.nome ?? '').trim();
        const n = nome.toLowerCase();
        if (!n) saida.set(l.id, { veredito: 'indeterminado', sinal: 'sem nome de status' });
        else if (/aberto/.test(n)) saida.set(l.id, { veredito: 'aberto', sinal: nome });
        else if (/agendad|loteament/.test(n)) saida.set(l.id, { veredito: 'agendado', sinal: nome });
        else if (/vendid|arrematad|encerrad|cancelad|retirad|suspens|deserto/.test(n)) {
          saida.set(l.id, { veredito: 'encerrado', sinal: nome });
        } else if (data.message?.recebeLance === false) {
          // "SEM LICITANTES" ficava indeterminado para sempre (nome fora da
          // lista acima). Ao contrário do soleon, o Freitas relista sob OUTRO
          // leilaoId em vez de reabrir a mesma URL — `recebeLance` é o próprio
          // sinal que a fonte usa, mais confiável que casar palavra por palavra.
          saida.set(l.id, { veredito: 'encerrado', sinal: nome });
        } else saida.set(l.id, { veredito: 'indeterminado', sinal: nome });
      } catch (e: any) {
        saida.set(l.id, { veredito: 'indeterminado', sinal: `erro: ${e?.message ?? e}` });
      }
    }
    return saida;
  },
};

export const VERIFICADORES: Record<string, Verificador> = { soleon, vlance, leilo, freitas };

export const temVerificador = (fonte: string) => fonte in VERIFICADORES;
