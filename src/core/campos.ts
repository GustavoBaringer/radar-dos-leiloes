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
