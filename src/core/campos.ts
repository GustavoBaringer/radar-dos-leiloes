/**
 * Normalização de campo, um lugar só.
 *
 * Cada conector entrega o que a fonte publica, e a fonte publica do jeito dela:
 * medido em 15/09/2026, `color` tinha BRANCA / branca / Branca como três
 * valores distintos, `fuel` tinha dez grafias para cinco combustíveis (incluindo
 * os códigos "A/G" e "G"), e `doc_type` estava recebendo CATEGORIA em metade dos
 * conectores — "Motocicletas", "Hatches", "Casas", "Terrenos Urbanos".
 *
 * A alternativa seria consertar isso em cada conector: doze vezes a mesma coisa,
 * e quebrado de novo no décimo terceiro. Aqui é o único ponto por onde todo lote
 * passa antes de virar linha no banco.
 */

const fold = (v: string) =>
  v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function texto(v?: string | null): string | null {
  const t = String(v ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o']);

/** Só reescreve texto TODO maiúsculo ou todo minúsculo: se a fonte já escreveu
 *  "Embu das Artes", mexer na caixa só poderia piorar. */
export function caixaDeTitulo(v?: string | null): string | null {
  const t = texto(v);
  if (!t) return null;
  const temMinuscula = /\p{Ll}/u.test(t);
  const temMaiuscula = /\p{Lu}/u.test(t);
  if (temMinuscula && temMaiuscula) return t;
  return t
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((p, i) => {
      if (/^(\s+|-|\/)$/.test(p)) return p;
      if (i > 0 && PARTICULAS.has(p)) return p;
      return p
        .replace(/^(\p{L})/u, (c) => c.toUpperCase())
        .replace(/'(\p{L})/u, (_, c) => `'${String(c).toUpperCase()}`);
    })
    .join('');
}

const UFS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);

/** A sigla é uma UF de verdade? Usado por conector que garimpa "Cidade - UF" em texto livre. */
export const ehUf = (v: string) => UFS.has(v.toUpperCase());

export function uf(v?: string | null): string | null {
  const t = texto(v)?.toUpperCase();
  if (!t) return null;
  if (UFS.has(t)) return t;
  const m = /\b([A-Z]{2})\b\s*$/.exec(t);
  return m && UFS.has(m[1]) ? m[1] : null;
}

const CORES: [RegExp, string][] = [
  [/^(branc|bca|whit)/, 'branco'],
  [/^(pret|black|negr)/, 'preto'],
  [/^(prat|silver)/, 'prata'],
  [/^(cinz|grafit|chumb|gray|grey)/, 'cinza'],
  [/^(vermelh|verm|red|bordo|vinho)/, 'vermelho'],
  [/^(azul|blue)/, 'azul'],
  [/^(verde|green)/, 'verde'],
  [/^(amarel|yellow|our|dourad|gold)/, 'amarelo'],
  [/^(marrom|brown|caramel|bege|areia|champ)/, 'marrom'],
  [/^(laranj|orange)/, 'laranja'],
  [/^(roxo|violet|lilas|purple)/, 'roxo'],
  [/^(rosa|pink)/, 'rosa'],
];

export function cor(v?: string | null): string | null {
  const t = fold(texto(v) ?? '');
  // "..." e "PARA" chegaram no campo de cor em lotes reais.
  if (!t || t.length < 3 || /^[.\-_/]+$/.test(t)) return null;
  for (const [re, c] of CORES) if (re.test(t)) return c;
  return null;
}

const COMBUSTIVEIS: [RegExp, string][] = [
  [/^(flex|bi.?combust|alcool\/gas|gas\/alcool|a\/g|g\/a|gas\/alc|alc\/gas)/, 'flex'],
  [/^(hibrid|hybrid)/, 'hibrido'],
  [/^(eletric|electric|ev$)/, 'eletrico'],
  [/^(diesel|dsl|d$)/, 'diesel'],
  [/^(alcool|etanol|alc$)/, 'alcool'],
  [/^(gnv|gas natural)/, 'gnv'],
  [/^(gasolina|gas$|g$)/, 'gasolina'],
];

export function combustivel(v?: string | null): string | null {
  const t = fold(texto(v) ?? '').replace(/\./g, '');
  if (!t) return null;
  for (const [re, c] of COMBUSTIVEIS) if (re.test(t)) return c;
  return null;
}

/**
 * Procedência do lote. Note o que NÃO é documentação: "Motocicletas", "Hatches",
 * "Casas", "Terrenos Urbanos" e "Tratores Agrícolas" chegavam aqui porque o
 * conector mandava a categoria da fonte neste campo. Categoria tem coluna
 * própria; aqui, valor irreconhecível vira nulo em vez de virar rótulo na tela.
 */
const DOCS: [RegExp, string][] = [
  [/judicial/, 'judicial'],
  [/extrajudicial/, 'extrajudicial'],
  [/(recuperad|retomad).*(financ|banc)|financiament/, 'recuperado_financiamento'],
  [/(seguradora|sinistr|colis|avariad|recuperavel|monta)/, 'sinistrado'],
  [/(sucata|inservivel|irrecuper|baixa obrigat)/, 'sucata'],
  [/(frota|locadora|desmobiliz)/, 'frota'],
  [/(normal|conservad|nao aplicavel|integro)/, 'conservado'],
];

export function docType(v?: string | null): string | null {
  const t = fold(texto(v) ?? '');
  if (!t) return null;
  for (const [re, d] of DOCS) if (re.test(t)) return d;
  return null;
}

export const DOC_LABEL: Record<string, string> = {
  judicial: 'Judicial',
  extrajudicial: 'Extrajudicial',
  recuperado_financiamento: 'Recuperado de financiamento',
  sinistrado: 'Sinistrado',
  sucata: 'Sucata',
  frota: 'Frota / locadora',
  conservado: 'Conservado',
};

export const COR_LABEL: Record<string, string> = {
  branco: 'Branco', preto: 'Preto', prata: 'Prata', cinza: 'Cinza',
  vermelho: 'Vermelho', azul: 'Azul', verde: 'Verde', amarelo: 'Amarelo',
  marrom: 'Marrom', laranja: 'Laranja', roxo: 'Roxo', rosa: 'Rosa',
};

export const COMBUSTIVEL_LABEL: Record<string, string> = {
  flex: 'Flex', gasolina: 'Gasolina', alcool: 'Álcool', diesel: 'Diesel',
  gnv: 'GNV', eletrico: 'Elétrico', hibrido: 'Híbrido',
};

/** Ano de 2 dígitos vira 4 com pivô no ano corrente. */
export function ano(v?: number | string | null): number | null {
  if (v == null || v === '') return null;
  let n = Number(String(v).replace(/\D/g, ''));
  if (!Number.isFinite(n) || n === 0) return null;
  if (n < 100) {
    const corrente = new Date().getFullYear() % 100;
    n = n <= corrente + 1 ? 2000 + n : 1900 + n;
  }
  return n >= 1900 && n <= new Date().getFullYear() + 2 ? n : null;
}

export function km(v?: number | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 2_000_000 ? Math.round(n) : null;
}

export function dinheiro(v?: number | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function url(v?: string | null): string | null {
  const t = texto(v);
  if (!t || !/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|mc_)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return t;
  }
}

export function fotos(v?: unknown[] | null): string[] {
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const f of v ?? []) {
    const u = texto(String(f ?? ''));
    if (!u || !/^https?:\/\//i.test(u)) continue;
    if (/(no[-_]?image|sem[-_]?imagem|lote_default|card-no-image|placeholder|nopic)/i.test(u)) continue;
    if (vistas.has(u)) continue;
    vistas.add(u);
    saida.push(u);
  }
  return saida;
}

/**
 * Título de exibição. A fonte escreve para o edital dela, não para quem busca:
 * "VW/VOYAGE CL, 92/92, SUCATA S/ DIREITO A DOCUMENTO, ALCOOL, PRATA" e
 * "vw gol 1999" são o mesmo produto escrito de dois jeitos.
 *
 * A regra que sustenta isso: só monta o título quando marca e modelo foram
 * RECONHECIDOS pelo dicionário. Sem isso, o título montado seria adivinhação
 * apresentada como fato — melhor devolver o da fonte com a caixa arrumada.
 */
/**
 * Nome próprio de marca e modelo. O dicionário guarda tudo em maiúscula, e
 * caixa de título cega transforma sigla em palavra: CG vira "Cg", HR-V vira
 * "Hr-V", HB20 vira "Hb20". Sigla curta e token com dígito continuam como são.
 */
export function nomeProprio(v?: string | null): string | null {
  const t = texto(v);
  if (!t) return null;
  return t
    .split(/([\s-]+)/)
    .map((tk) => {
      if (/^[\s-]+$/.test(tk) || !tk) return tk;
      const soLetras = tk.replace(/[^\p{L}]/gu, '');
      if (/\d/.test(tk) && /\p{L}/u.test(tk)) return tk.toUpperCase();
      // Sigla curta SEM VOGAL continua sigla (CG, FH, XRE, HR-V); com vogal é
      // palavra e vira nome (GOL, UNO, KA), senão o título fica gritando.
      if (tk === tk.toUpperCase() && soLetras.length <= 3 && !/[AEIOU]/i.test(soLetras)) {
        return tk.toUpperCase();
      }
      return caixaDeTitulo(tk.toLowerCase()) ?? tk;
    })
    .join('');
}

/**
 * A versão chega carregando o resto do anúncio: "PALIO FIRE 2003 2004 AZUL
 * Sucata Motor" e "CG 125 FAN – 07/07 – Palestina/SP" são valores reais do
 * campo. Sem podar, o título padronizado repete modelo, ano e cor.
 */
function versaoLimpa(versao?: string | null, modelo?: string | null): string | null {
  let v = texto(versao);
  if (!v) return null;
  v = v.split(/[,;–]|\s-\s/)[0];
  if (modelo) {
    const escapado = modelo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    v = v.replace(new RegExp(escapado, 'gi'), ' ');
  }
  v = v
    .replace(/\b(ano|modelo|placa|sucata|servivel|inservivel|cor)\b.*/i, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{2}\/\d{2}\b/g, ' ')
    .replace(/\b(branc|pret|prat|cinz|vermelh|azul|verde|amarel|marrom|bege)\w*/gi, ' ');
  const limpo = texto(v)?.replace(/^[^\p{L}\d(]+|[^\p{L}\d)]+$/gu, '');
  return limpo && limpo.replace(/[^\p{L}\d]/gu, '').length >= 2 ? nomeProprio(limpo) : null;
}

export function tituloVeiculo(p: {
  brand?: string | null;
  model?: string | null;
  version?: string | null;
  yearMake?: number | null;
  yearModel?: number | null;
  titleRaw: string;
}): string {
  const marca = nomeProprio(p.brand);
  const modelo = nomeProprio(p.model);
  if (!marca || !modelo) return caixaDeTitulo(p.titleRaw) ?? p.titleRaw;

  const partes = [marca, modelo];
  const versao = versaoLimpa(p.version, p.model);
  if (versao) partes.push(versao);

  const fab = ano(p.yearMake);
  const mod = ano(p.yearModel);
  if (fab && mod && fab !== mod) partes.push(`${fab}/${mod}`);
  else if (mod ?? fab) partes.push(String(mod ?? fab));

  return partes.join(' ');
}

/**
 * Bairro no formato "Tipo - BAIRRO - CIDADE/UF", que é como a Caixa publica os
 * 5.189 imóveis dela. Sem isso, padronizar o título APAGA o bairro, que é
 * justamente o que separa dois apartamentos na mesma cidade.
 */
export function bairroDoTitulo(titleRaw: string, city?: string | null): string | null {
  const partes = String(titleRaw).split(' - ').map((x) => x.trim()).filter(Boolean);
  if (partes.length < 3) return null;
  const meio = caixaDeTitulo(partes[partes.length - 2]);
  if (!meio || meio.length < 3) return null;
  const mesmaCidade = city && fold(meio) === fold(city);
  return mesmaCidade ? null : meio;
}

export function tituloImovel(p: {
  propertyType?: string | null;
  area?: number | null;
  city?: string | null;
  state?: string | null;
  neighborhood?: string | null;
  titleRaw: string;
}): string {
  const TIPO: Record<string, string> = {
    apartamento: 'Apartamento', casa: 'Casa', terreno: 'Terreno',
    comercial: 'Imóvel comercial', rural: 'Imóvel rural', vaga: 'Vaga de garagem',
  };
  const tipo = p.propertyType ? TIPO[p.propertyType] : null;
  const cidade = caixaDeTitulo(p.city);
  const estado = uf(p.state);
  if (!tipo || !cidade) return caixaDeTitulo(p.titleRaw) ?? p.titleRaw;

  const area = p.area != null && p.area > 0 && p.area < 10_000_000 ? `${Math.round(p.area)} m²` : null;
  const onde = [p.neighborhood, estado ? `${cidade}/${estado}` : cidade].filter(Boolean).join(', ');
  return [tipo, area, 'em', onde].filter(Boolean).join(' ');
}

/** Nome do estado por extenso -> sigla. A fonte escreve dos dois jeitos. */
const ESTADO_POR_EXTENSO: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE',
  'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
  paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
};

const semAcento = (v: string) =>
  v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Garimpa "Cidade/UF" em texto livre — título, nome do leilão, slug de URL.
 *
 * Existe porque três conectores tinham cada um a sua tentativa e nenhuma cobria
 * o suficiente: leilaopro não extraía cidade nenhuma (472 lotes, 100%),
 * suaplataforma lia só do título (83% falhavam) e suporteleiloes, só de um
 * rótulo (51% falhavam). Uma regra só, aplicada aos três campos, em vez de
 * quatro regras para divergir.
 *
 * O ÚLTIMO par vence, pelo mesmo motivo do conector do soleon: o endereço
 * termina em cidade e UF, e o primeiro par costuma ser um prefixo qualquer
 * ("AV" passando por sigla de estado).
 *
 * Aceita o estado por extenso ("Vacaria/Rio Grande do Sul") porque é assim que
 * o suporte-leilões escreve em boa parte dos títulos.
 */
export function localDeTexto(texto?: string | null): { city: string; uf: string } | null {
  const t = String(texto ?? '');
  if (!t) return null;

  const achados: Array<{ city: string; uf: string }> = [];

  /**
   * "Cidade/UF" e "Cidade - UF" — com a BARRA, ou com hífen CERCADO DE ESPAÇO.
   *
   * Hífen colado está fora de propósito: meia língua portuguesa termina em duas
   * letras que são sigla de estado, e "o veículo encontra-se" virava a cidade
   * "O veículo encontra" no estado de Sergipe. O dry-run pegou.
   */
  for (const m of t.matchAll(/([A-Za-zÀ-ú][A-Za-zÀ-ú'.\s]{2,40}?)\s*(?:\/\s*|\s-\s)([A-Za-z]{2})(?![A-Za-zÀ-ú])/g)) {
    if (ehUf(m[2])) achados.push({ city: m[1].trim(), uf: m[2].toUpperCase() });
  }
  // "Cidade/Nome Do Estado" por extenso.
  for (const m of t.matchAll(/([A-Za-zÀ-ú][A-Za-zÀ-ú'.\s]{2,40}?)\s*[/-]\s*([A-Za-zÀ-ú][A-Za-zÀ-ú\s]{3,25})(?![A-Za-zÀ-ú])/g)) {
    const uf = ESTADO_POR_EXTENSO[semAcento(m[2])];
    if (uf) achados.push({ city: m[1].trim(), uf });
  }
  /**
   * Slug de URL: "apartamento-santo-andre-sp" -> Santo André/SP.
   *
   * A sigla tem de fechar o SEGMENTO (vem "/" ou fim depois), não um hífen
   * qualquer: senão "leilao-fiat-doblo-2011" e "encontra-se" entram.
   */
  for (const m of t.matchAll(/([a-z][a-z-]{2,40}?)-([a-z]{2})(?=\/|$)/g)) {
    if (!ehUf(m[2])) continue;
    const cidade = m[1].split('-').slice(-4).join(' ');
    achados.push({ city: cidade, uf: m[2].toUpperCase() });
  }

  const ultimo = achados.pop();
  if (!ultimo) return null;
  const podada = apararCidade(ultimo.city);
  // "Novo Hamburgo e Campo Bom/RS": o leilão cobre DUAS cidades. Escolher uma
  // seria chute com cara de dado. Fica sem cidade, que é a verdade.
  if (/\s+e\s+/i.test(podada)) return null;
  const city = caixaDeTitulo(podada);
  return city ? { city, uf: ultimo.uf } : null;
}

/**
 * Tira o que vem ANTES do nome da cidade.
 *
 * O texto livre traz o tipo do bem e a preposição colados: "EXTRAJUDICIAL I ÁREA
 * EM Santa Luzia" e "apartamento-santo-andre". Sem aparar, a "cidade" sai como
 * "Extrajudicial I Área em Santa Luzia" — e aí ela nunca casa com município
 * nenhum, o que é pior do que não ter extraído.
 *
 * Duas podas, nesta ordem:
 *  1. a preposição de lugar ("em", "no", "na"): o nome começa DEPOIS dela;
 *  2. as palavras de tipo do bem no início ("apartamento", "terreno", "leilão").
 * Preposição interna ("de", "dos") fica: "Patos de Minas" e "São José dos
 * Pinhais" são nomes legítimos.
 */
/** Rótulo institucional colado no nome do lugar: "Município de X", "Fórum de X". */
const RÓTULO_DE_LUGAR = /\b(munic[íi]pio|f[óo]rum|comarca|prefeitura|cart[óo]rio|vara|distrito)\s+(de|do|da|dos|das)\s+/i;

const TIPOS_DE_BEM =
  /^(leilao|leilão|judicial|extrajudicial|im[óo]vel|imoveis|apartamento|apto|casa|terreno|lote|area|área|sala|loja|galpao|galpão|chacara|chácara|sitio|sítio|fazenda|vaga|predio|prédio|cobertura|duplex|sobrado|kitnet|comercial|residencial|rural|unidade|ha|m2)\b[\s-]*/i;

export function apararCidade(bruto: string): string {
  let v = bruto.replace(/[\s,;:|]+$/, '').trim();
  // "Município de Pinhal Grande" -> "Pinhal Grande".
  const rotulo = [...v.matchAll(new RegExp(RÓTULO_DE_LUGAR.source, 'gi'))].pop();
  if (rotulo) v = v.slice(rotulo.index! + rotulo[0].length);
  // A última preposição de lugar marca onde o nome começa.
  const prep = [...v.matchAll(/\b(?:em|no|na|nos|nas)\s+/gi)].pop();
  if (prep) v = v.slice(prep.index! + prep[0].length);
  // Vírgula e barra vertical separam o tipo do bem do lugar.
  v = v.split(/[,|]/).pop()!.trim();
  // Palavras de tipo do bem sobrando no começo.
  let antes: string;
  do {
    antes = v;
    v = v.replace(TIPOS_DE_BEM, '').trim();
  } while (v !== antes && v);
  // Nome de município tem no máximo ~5 palavras ("São João del Rei", "Santo
  // Antônio de Pádua"); mais que isso é texto que escapou das podas.
  const palavras = v.split(/\s+/).filter(Boolean);
  return palavras.slice(-5).join(' ');
}

/**
 * Nome de leiloeiro publicado pela fonte, ou nulo. Leilão de teste da própria
 * plataforma vaza "Leiloeiro Oficial Exemplo" para a faceta, e rótulo sem nome
 * atrás ("Leiloeiro Oficial") não identifica ninguém.
 */
export function nomeDeLeiloeiro(v: unknown): string | null {
  const nome = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!nome) return null;
  if (/\b(exemplo|teste|placeholder|sem nome)\b/i.test(nome)) return null;
  if (/^(leiloeir[ao]|comiss|cadastrad|lance|lote|edital|aguarde)(\s+(oficial|p[úu]blic[oa]))*$/i.test(nome)) return null;
  return nome;
}
