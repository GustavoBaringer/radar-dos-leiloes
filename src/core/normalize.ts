/**
 * Normalizador de marca/modelo e de consulta.
 *
 * Existe porque NENHUMA fonte normaliza: medido em 14/09/2026,
 *  - "t-cross" devolve 0 no VIP e no Kuss, enquanto "T CROSS" devolve 5;
 *  - "mercedes b 200" devolve GLA 200 no Leilo e caminhões Actros na Copart;
 *  - "nivus" no Superbid devolve bronzinas (peça, não veículo);
 *  - "hb 20" na Copart devolve o estoque inteiro (13 mil lotes).
 * Por isso a busca do produto roda no nosso índice, nunca repassada à fonte.
 */

export function fold(input: string): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Versão sem separadores: faz "t-cross", "t cross" e "tcross" colidirem. */
export function compact(input: string): string {
  return fold(input).replace(/ /g, '');
}

interface BrandDef {
  canonical: string;
  aliases: string[];
  models: Record<string, string[]>;
}

const BRANDS: BrandDef[] = [
  {
    canonical: 'VOLKSWAGEN',
    aliases: ['volkswagen', 'vw', 'volks', 'wolksvagen', 'volkswagem'],
    models: {
      'T-CROSS': ['t cross', 'tcross', 't-cross'],
      NIVUS: ['nivus'],
      POLO: ['polo'],
      VIRTUS: ['virtus'],
      GOL: ['gol', 'novo gol'],
      SAVEIRO: ['saveiro'],
      VOYAGE: ['voyage'],
      JETTA: ['jetta'],
      TIGUAN: ['tiguan', 'tiguan allspace'],
      AMAROK: ['amarok'],
      FOX: ['fox'],
      CROSSFOX: ['crossfox', 'cross fox'],
      SPACEFOX: ['spacefox', 'space fox'],
      UP: ['up'],
      TAOS: ['taos'],
      GOLF: ['golf'],
      PASSAT: ['passat'],
    },
  },
  {
    canonical: 'CHEVROLET',
    aliases: ['chevrolet', 'gm', 'chevy', 'general motors'],
    models: {
      ONIX: ['onix', 'onix plus'],
      PRISMA: ['prisma'],
      TRACKER: ['tracker'],
      SPIN: ['spin'],
      CRUZE: ['cruze'],
      S10: ['s10', 's 10'],
      MONTANA: ['montana'],
      CELTA: ['celta'],
      CLASSIC: ['classic'],
      COBALT: ['cobalt'],
      EQUINOX: ['equinox'],
      CAMARO: ['camaro'],
      CORSA: ['corsa'],
    },
  },
  {
    canonical: 'FIAT',
    aliases: ['fiat'],
    models: {
      ARGO: ['argo'],
      CRONOS: ['cronos'],
      MOBI: ['mobi'],
      TORO: ['toro'],
      STRADA: ['strada'],
      PULSE: ['pulse'],
      FASTBACK: ['fastback'],
      UNO: ['uno'],
      PALIO: ['palio'],
      SIENA: ['siena', 'grand siena'],
      DOBLO: ['doblo'],
      FIORINO: ['fiorino'],
      PUNTO: ['punto'],
      IDEA: ['idea'],
      DUCATO: ['ducato'],
    },
  },
  {
    canonical: 'FORD',
    aliases: ['ford'],
    models: {
      KA: ['ka', 'ka sedan'],
      FIESTA: ['fiesta'],
      ECOSPORT: ['ecosport', 'eco sport'],
      RANGER: ['ranger'],
      FOCUS: ['focus'],
      FUSION: ['fusion'],
      TERRITORY: ['territory'],
      BRONCO: ['bronco', 'bronco sport'],
      MAVERICK: ['maverick'],
      TRANSIT: ['transit'],
      F250: ['f250', 'f 250'],
    },
  },
  {
    canonical: 'HYUNDAI',
    aliases: ['hyundai', 'hiunday'],
    models: {
      HB20: ['hb20', 'hb 20', 'hb20s', 'hb20x'],
      CRETA: ['creta'],
      TUCSON: ['tucson'],
      IX35: ['ix35', 'ix 35'],
      SANTA_FE: ['santa fe', 'santafe'],
      ELANTRA: ['elantra'],
      AZERA: ['azera'],
      HR: ['hr'],
    },
  },
  {
    canonical: 'TOYOTA',
    aliases: ['toyota'],
    models: {
      COROLLA: ['corolla'],
      'COROLLA CROSS': ['corolla cross', 'corollacross'],
      HILUX: ['hilux', 'hi lux'],
      YARIS: ['yaris'],
      ETIOS: ['etios'],
      SW4: ['sw4', 'sw 4'],
      RAV4: ['rav4', 'rav 4'],
      CAMRY: ['camry'],
    },
  },
  {
    canonical: 'HONDA',
    aliases: ['honda'],
    models: {
      CIVIC: ['civic'],
      FIT: ['fit'],
      CITY: ['city'],
      'HR-V': ['hrv', 'hr v', 'hr-v'],
      'WR-V': ['wrv', 'wr v', 'wr-v'],
      CRV: ['crv', 'cr v', 'cr-v'],
      CG: ['cg', 'cg 160', 'cg160', 'cg 125'],
      BIZ: ['biz'],
      POP: ['pop'],
      CB: ['cb', 'cb 250', 'cb250', 'cb 300'],
      XRE: ['xre'],
      PCX: ['pcx'],
    },
  },
  {
    canonical: 'RENAULT',
    aliases: ['renault', 'renaut'],
    models: {
      KWID: ['kwid'],
      SANDERO: ['sandero'],
      LOGAN: ['logan'],
      DUSTER: ['duster'],
      CAPTUR: ['captur'],
      OROCH: ['oroch'],
      MASTER: ['master'],
      STEPWAY: ['stepway'],
      KANGOO: ['kangoo'],
    },
  },
  {
    canonical: 'JEEP',
    aliases: ['jeep'],
    models: {
      RENEGADE: ['renegade'],
      COMPASS: ['compass'],
      COMMANDER: ['commander'],
      GLADIATOR: ['gladiator'],
    },
  },
  {
    canonical: 'NISSAN',
    aliases: ['nissan'],
    models: {
      KICKS: ['kicks'],
      VERSA: ['versa'],
      MARCH: ['march'],
      FRONTIER: ['frontier'],
      SENTRA: ['sentra'],
    },
  },
  {
    canonical: 'PEUGEOT',
    aliases: ['peugeot', 'peugeout'],
    models: {
      '206': ['206'],
      '207': ['207'],
      '208': ['208'],
      '2008': ['2008'],
      '3008': ['3008'],
      '308': ['308'],
      PARTNER: ['partner'],
      BOXER: ['boxer'],
    },
  },
  {
    canonical: 'CITROEN',
    aliases: ['citroen', 'citroën'],
    models: {
      C3: ['c3'],
      C4: ['c4', 'c4 cactus', 'c4 lounge'],
      AIRCROSS: ['aircross'],
      JUMPER: ['jumper'],
      JUMPY: ['jumpy'],
    },
  },
  {
    canonical: 'MERCEDES-BENZ',
    aliases: ['mercedes', 'mercedes benz', 'mercedes-benz', 'mb', 'merc'],
    models: {
      // Classe B: "b 200" é a armadilha que o Leilo confunde com GLA 200.
      'CLASSE B': ['classe b', 'b 200', 'b200', 'b 180', 'b180', 'classe b 200'],
      'CLASSE A': ['classe a', 'a 200', 'a200', 'a 250', 'a250'],
      'CLASSE C': ['classe c', 'c 180', 'c180', 'c 200', 'c200', 'c 250'],
      'CLASSE E': ['classe e', 'e 250', 'e250'],
      GLA: ['gla', 'gla 200', 'gla200'],
      GLC: ['glc', 'glc 250'],
      SPRINTER: ['sprinter'],
      ACTROS: ['actros'],
      ATEGO: ['atego'],
      AXOR: ['axor'],
      ACCELO: ['accelo'],
    },
  },
  {
    canonical: 'BMW',
    aliases: ['bmw'],
    models: {
      '320I': ['320i', '320 i'],
      X1: ['x1'],
      X3: ['x3'],
      X5: ['x5'],
      '118I': ['118i'],
      '328I': ['328i'],
    },
  },
  {
    canonical: 'AUDI',
    aliases: ['audi'],
    models: { A3: ['a3'], A4: ['a4'], Q3: ['q3'], Q5: ['q5'], A1: ['a1'] },
  },
  {
    canonical: 'YAMAHA',
    aliases: ['yamaha'],
    models: {
      FAZER: ['fazer', 'ys 250'],
      FACTOR: ['factor', 'ybr'],
      MT03: ['mt03', 'mt 03'],
      NMAX: ['nmax', 'n max'],
      XTZ: ['xtz', 'lander', 'crosser'],
    },
  },
  {
    canonical: 'MITSUBISHI',
    aliases: ['mitsubishi'],
    models: { L200: ['l200', 'l 200'], PAJERO: ['pajero'], OUTLANDER: ['outlander'], ASX: ['asx'] },
  },
  {
    canonical: 'CAOA CHERY',
    aliases: ['caoa chery', 'chery', 'caoa'],
    models: { TIGGO: ['tiggo', 'tiggo 5x', 'tiggo 7', 'tiggo 8'], ARRIZO: ['arrizo'], QQ: ['qq'] },
  },
  {
    canonical: 'VOLVO',
    aliases: ['volvo'],
    models: { XC40: ['xc40'], XC60: ['xc60'], FH: ['fh'], VM: ['vm'] },
  },
  { canonical: 'KIA', aliases: ['kia'], models: { SPORTAGE: ['sportage'], CERATO: ['cerato'], SORENTO: ['sorento'], PICANTO: ['picanto'] } },
  { canonical: 'SCANIA', aliases: ['scania'], models: { R440: ['r440'], P310: ['p310'], G420: ['g420'] } },
  { canonical: 'IVECO', aliases: ['iveco'], models: { DAILY: ['daily'], TECTOR: ['tector'] } },
  { canonical: 'SUZUKI', aliases: ['suzuki'], models: { JIMNY: ['jimny'], VITARA: ['vitara'] } },
  { canonical: 'LAND ROVER', aliases: ['land rover', 'landrover'], models: { DISCOVERY: ['discovery'], EVOQUE: ['evoque'], DEFENDER: ['defender'] } },
  { canonical: 'JAC', aliases: ['jac'], models: { T40: ['t40'], IEV: ['iev'] } },
  { canonical: 'TROLLER', aliases: ['troller'], models: { T4: ['t4'] } },
  { canonical: 'DAFRA', aliases: ['dafra'], models: { CITYCOM: ['citycom'] } },
  { canonical: 'SHINERAY', aliases: ['shineray'], models: {} },
  { canonical: 'HAOJUE', aliases: ['haojue'], models: {} },
];

/**
 * Termos que denunciam PEÇA, não veículo. Na Copart e no Superbid
 * "nivus" traz bronzinas e "hb 20" traz cabeçote — o filtro de categoria
 * da fonte não basta, então a exclusão é nossa.
 */
const PART_MARKERS = [
  'cabecote', 'bronzina', 'bronzinas', 'pistao', 'virabrequim', 'radiador',
  'parachoque', 'para choque', 'retrovisor', 'farol', 'lanterna', 'capo',
  'porta dianteira', 'porta traseira', 'sucata de cabine', 'motor parcial',
  'jogo de', 'kit de', 'par de', 'lote de pecas', 'pecas diversas',
  'cambio do', 'motor do', 'caixa de cambio', 'diferencial do', 'turbina do',
  'mobilete', 'bomba injetora', 'cabine de', 'eixo de', 'eixos de',
];

const brandIndex = new Map<string, BrandDef>();
for (const b of BRANDS) {
  for (const a of [...b.aliases, b.canonical]) brandIndex.set(compact(a), b);
}

export function looksLikePart(title: string): boolean {
  const f = fold(title);
  return PART_MARKERS.some((m) => f.includes(fold(m)));
}

export interface ParsedVehicle {
  brand: string | null;
  model: string | null;
  version: string | null;
  yearMake: number | null;
  yearModel: number | null;
}

/** Extrai marca/modelo/ano do título livre que cada fonte escreve à sua maneira. */
export function parseTitle(titleRaw: string, hintBrand?: string | null, hintModel?: string | null): ParsedVehicle {
  const folded = fold(titleRaw);
  const compactTitle = compact(titleRaw);
  let brand: string | null = null;
  let model: string | null = null;

  if (hintBrand) {
    const hit = brandIndex.get(compact(hintBrand));
    if (hit) brand = hit.canonical;
  }
  if (!brand) {
    // Ordena por alias mais longo: "land rover" tem de vencer "rover" solto,
    // e a forma COM espaço precisa ser testada — a compacta sozinha falhava
    // em "LAND ROVER RANGE ROVER" (landrover seguido de letra, sem fronteira).
    const aliasesByLen = [...brandIndex.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [aliasCompact, def] of aliasesByLen) {
      if (aliasCompact.length < 2) continue;
      const spaced = [...def.aliases, def.canonical].map(fold).find((a) => compact(a) === aliasCompact) ?? aliasCompact;
      const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (
        new RegExp(`(^|[^a-z0-9])${esc(spaced)}([^a-z0-9]|$)`).test(folded) ||
        new RegExp(`(^|[^a-z0-9])${esc(aliasCompact)}([^a-z0-9]|$)`).test(folded.replace(/ /g, ''))
      ) {
        brand = def.canonical;
        break;
      }
    }
  }

  const searchIn = `${folded} ${hintModel ? fold(hintModel) : ''}`;
  // Tokens e pares adjacentes, em vez de substring livre: `includes` fazia
  // "GL 2000 I" casar com L200 e "MOBILETE" casar com MOBI.
  const rawTokens = `${folded} ${hintModel ? fold(hintModel) : ''}`.split(' ').filter(Boolean);
  const compactTokens = new Set<string>(rawTokens);
  for (let i = 0; i < rawTokens.length - 1; i++) compactTokens.add(rawTokens[i] + rawTokens[i + 1]);
  void compactTitle;
  const candidates = brand ? BRANDS.filter((b) => b.canonical === brand) : BRANDS;

  let bestLen = 0;
  let yearishFallback: { model: string; brand: string; len: number } | null = null;
  for (const b of candidates) {
    for (const [canonicalModel, aliases] of Object.entries(b.models)) {
      for (const alias of aliases) {
        const aliasCompact = compact(alias);
        if (aliasCompact.length < 2) continue;
        // Alias só de dígitos exige marca já confirmada: sem isso
        // "2008 RANDON SEMI-REBOQUE" virava um Peugeot 2008.
        if (/^\d+$/.test(aliasCompact) && b.canonical !== brand) continue;
        // Mesma trava, para alias de DUAS letras. "CG" e "CB" no título de
        // semirreboque são código de carroceria do RENAVAM (Carga Geral, Carga
        // Basculante) e viravam Honda CG/CB: 17 reboques exibidos como moto.
        // Sigla de duas letras confirma um modelo quando a marca já é conhecida,
        // mas não tem especificidade para DEFINIR a marca sozinha.
        if (aliasCompact.length <= 2 && b.canonical !== brand) continue;
        const hit =
          new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(searchIn) ||
          (aliasCompact.length >= 4 && compactTokens.has(aliasCompact));
        if (!hit) continue;
        // "PEUGEOT 206 2008": 2008 é ano, 206 é o modelo. Um alias numérico
        // que também é ano plausível fica em espera e só vale se nada melhor casar.
        const n = Number(aliasCompact);
        const pareceAno = /^\d{4}$/.test(aliasCompact) && n >= 1980 && n <= 2035;
        if (pareceAno) {
          if (!yearishFallback || aliasCompact.length > yearishFallback.len) {
            yearishFallback = { model: canonicalModel, brand: b.canonical, len: aliasCompact.length };
          }
          continue;
        }
        if (aliasCompact.length > bestLen) {
          bestLen = aliasCompact.length;
          model = canonicalModel;
          if (!brand) brand = b.canonical;
        }
      }
    }
  }
  if (!model && yearishFallback) {
    model = yearishFallback.model;
    if (!brand) brand = yearishFallback.brand;
  }

  const years = [...titleRaw.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const pairs = titleRaw.match(/\b(\d{2})\s*\/\s*(\d{2})\b/);
  let yearMake: number | null = null;
  let yearModel: number | null = null;
  if (pairs) {
    yearMake = 2000 + Number(pairs[1]) > 2050 ? 1900 + Number(pairs[1]) : 2000 + Number(pairs[1]);
    yearModel = 2000 + Number(pairs[2]) > 2050 ? 1900 + Number(pairs[2]) : 2000 + Number(pairs[2]);
  } else if (years.length >= 2) {
    yearMake = years[0];
    yearModel = years[1];
  } else if (years.length === 1) {
    yearMake = years[0];
    yearModel = years[0];
  }

  let version: string | null = null;
  if (model) {
    const idx = folded.indexOf(fold(model).split(' ')[0]);
    if (idx >= 0) {
      version = titleRaw.slice(idx).replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    }
  }

  return { brand, model, version, yearMake, yearModel };
}

/**
 * Texto de busca gravado no lote. Guarda a forma com espaços E a compacta,
 * para que "t cross" e "tcross" caiam no mesmo índice trigram.
 */
export function buildSearchText(parts: Array<string | null | undefined>): string {
  const folded = fold(parts.filter(Boolean).join(' '));
  const tokens = folded.split(' ').filter(Boolean);
  const compacted = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) compacted.add(tokens[i] + tokens[i + 1]);
  return [folded, ...compacted].join(' ').trim();
}

export interface ParsedQuery {
  raw: string;
  brand: string | null;
  model: string | null;
  freeTerms: string[];
  compactTerm: string;
}

/** Interpreta a consulta do usuário: marca e modelo quando reconhecíveis, resto vira termo livre. */
export function parseQuery(raw: string): ParsedQuery {
  const q = fold(raw);
  if (!q) return { raw, brand: null, model: null, freeTerms: [], compactTerm: '' };

  let brand: string | null = null;
  let remaining = q;
  for (const b of BRANDS) {
    for (const alias of [...b.aliases, b.canonical.toLowerCase()]) {
      const a = fold(alias);
      const re = new RegExp(`(^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
      if (re.test(q)) {
        brand = b.canonical;
        remaining = q.replace(re, ' ').trim();
        break;
      }
    }
    if (brand) break;
  }

  let model: string | null = null;
  let matchedAlias: string | null = null;
  const pool = brand ? BRANDS.filter((b) => b.canonical === brand) : BRANDS;
  let bestLen = 0;
  for (const b of pool) {
    for (const [canonicalModel, aliases] of Object.entries(b.models)) {
      for (const alias of aliases) {
        const a = fold(alias);
        const ac = compact(alias);
        const matches =
          new RegExp(`(^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(remaining) ||
          (ac.length >= 4 && compact(remaining) === ac);
        if (matches && ac.length > bestLen) {
          bestLen = ac.length;
          model = canonicalModel;
          matchedAlias = a;
          if (!brand) brand = b.canonical;
        }
      }
    }
  }

  // O alias que casou sai dos termos livres: senão "hb 20" deixaria "hb" e "20"
  // soltos e o trigram voltaria a trazer cabeçote.
  const used = new Set<string>();
  if (model) for (const t of fold(model).split(' ')) used.add(t);
  if (brand) for (const t of fold(brand).split(' ')) used.add(t);
  if (matchedAlias) for (const t of matchedAlias.split(' ')) used.add(t);
  const modelCompact = model ? compact(model) : '';
  const freeTerms = remaining
    .split(' ')
    .filter((t) => t && !used.has(t) && !(modelCompact && (modelCompact.includes(compact(t)) || compact(t) === modelCompact)));

  return { raw, brand, model, freeTerms, compactTerm: compact(raw) };
}

export function classifySeller(name?: string | null): string {
  const n = fold(name ?? '');
  if (!n) return 'desconhecido';
  if (/(seguro|seguros|seguradora|porto seguro|mapfre|allianz|tokio|azul seguros|hdi|sompo|ezze)/.test(n)) return 'seguradora';
  if (/(banco|bradesco|itau|santander|safra|bv |votorantim|caixa|honda|aymore|omni|pan|daycoval)/.test(n)) return 'banco';
  if (/(financ|credito|cfi|fidc|itapeva|multicarteira|securitizadora)/.test(n)) return 'financeira';
  if (/(localiza|movida|unidas|locali|locadora|rent a car|ouro verde)/.test(n)) return 'locadora';
  if (/(tribunal|tj|vara|justica|judicial|leilao judicial|pgfn)/.test(n)) return 'judicial';
  if (/(detran|prefeitura|municipio|governo|receita|policia|estado de)/.test(n)) return 'orgao';
  return 'desconhecido';
}

/**
 * Remove placa do texto ANTES de ele virar título e índice de busca.
 * Sem isso a placa vira chave de consulta (medido: `?q=mbv 2257` devolvia o
 * veículo, a comarca e o pátio). Os três padrões são conservadores de
 * propósito: "CARGO 2429" e "CG 125 TITAN, 2003" NÃO podem ser confundidos
 * com placa, senão o scrub come modelo e ano.
 */
const PLATE_PATTERNS: RegExp[] = [
  /(placas?\s*(?:n[ºo°]?\.?)?[:\s-]*)([A-Za-z]{3})[\s-]?(\d{4})/gi, // rotulada
  /\b([A-Za-z]{3})(\d)([A-Za-z])(\d{2})\b/g,                        // Mercosul ABC1D23
  /(?<![A-Za-z0-9])([A-Za-z]{3})-(\d{4})(?![0-9])/g,                  // hifenizada ABC-1234
  // Mercosul com separador ("placa GDF 9A28") e formato curto antigo
  // ("Placa EH944") escapavam dos três de cima. Só com rótulo "placa" na
  // frente: sem ele, "SP 123" de um endereço viraria placa mascarada.
  /(placas?\s*(?:n[ºo°]?\.?)?[:\s-]*)([A-Za-z]{3})[\s-](\d)([A-Za-z])(\d{2})/gi,
  /(placas?\s*(?:n[ºo°]?\.?)?[:\s-]*)([A-Za-z]{2,3})[\s-]?(\d{3})(?![0-9A-Za-z])/gi,
];

/**
 * Identificadores do veículo que também são dado pessoal por vínculo:
 * chassi (VIN), RENAVAM e número de motor. A plataforma SOLEON publica os três
 * em texto livre na Descrição (rjleiloes e kildare não mascaram nada), e num
 * caso o campo estruturado vem mascarado enquanto a Descrição do MESMO lote
 * mostra a placa inteira. Por isso o scrub roda sobre o texto, não sobre o campo.
 */
// O "nº" entre o rótulo e o valor é a forma MAIS comum no texto jurídico
// brasileiro ("chassi nº 34403212418620") e era justamente a que escapava:
// 13 lotes gravaram chassi e RENAVAM em claro enquanto a placa do mesmo
// texto saía mascarada por outro padrão.
const ROTULO_NUMERO = '(?:n[ºo°]?\\.?\\s*)?';
const ID_VEICULO_PATTERNS: RegExp[] = [
  new RegExp(`(chassi\\s*:?\\s*${ROTULO_NUMERO}:?\\s*)((?=[A-Z0-9]*\\d[A-Z0-9]*\\d)[A-Z0-9]{7,17})`, 'gi'),
  new RegExp(`(renava[nm]\\s*:?\\s*${ROTULO_NUMERO}:?\\s*)(\\d{6,11})`, 'gi'),
  new RegExp(
    `((?:n[ºo°]?\\.?\\s*(?:d[eo]\\s*)?)?motor\\s*:?\\s*${ROTULO_NUMERO}:?\\s*)((?=[A-Z0-9]*\\d[A-Z0-9]*\\d)[A-Z0-9]{6,})`,
    'gi',
  ),
];

export interface ScrubResult {
  text: string;
  plateMasked: string | null;
}

export function scrubPlates(input: string): ScrubResult {
  let text = input ?? '';
  let found: string | null = null;
  for (const re of ID_VEICULO_PATTERNS) {
    text = text.replace(re, (_m, rotulo: string, valor: string) => `${rotulo}${'*'.repeat(Math.min(6, valor.length))}`);
  }
  for (const re of PLATE_PATTERNS) {
    text = text.replace(re, (match, ...groups) => {
      const parts = groups.slice(0, -2).filter((g) => typeof g === 'string');
      const label = /placa/i.test(String(parts[0] ?? '')) ? String(parts[0]) : '';
      const raw = (label ? parts.slice(1) : parts).join('');
      if (!found) found = maskPlate(raw);
      return `${label}${found ?? '***'}`;
    });
  }
  return { text, plateMasked: found };
}

/** Placa nunca é persistida em claro: LGPD (Sato e Kuss expõem dado pessoal). */
export function maskPlate(plate?: string | null): string | null {
  if (!plate) return null;
  const p = plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (p.length < 4) return null;
  return `${p.slice(0, 1)}**-**${p.slice(-2)}`;
}

export const BRAND_LIST = BRANDS.map((b) => b.canonical).sort();

/* ------------------------------------------------------------------ *
 * Classificação de tipo de bem e de veículo
 * ------------------------------------------------------------------ */

import type { AssetType, PropertyType, VehicleType } from './types.js';

/**
 * De-para das taxonomias REAIS das fontes (contadas no banco em 14/09/2026).
 * A fonte é sempre mais confiável que o título: só quando ela não classifica
 * é que caímos na inferência por texto.
 */
const CATEGORIA_FONTE: Array<[RegExp, VehicleType]> = [
  // Máquina inteira antes de peça: "Tratores de Esteira e Pneus" casava com
  // 'pneu' e 37 tratores do Superbid entraram no índice como peça.
  [/\b(trator(es)? de (esteira|pneu)|motoniveladora|retroescavadeira|escavadeira|colheitadeira|empilhadeira|carregadeira)/, 'maquina'],
  // Ordem importa: 'peca' antes do resto, senão "Partes & Peças Carros" vira carro.
  [/\b(pe[cç]a|pneu|roda|motores?\b|partes|cabe[cç]ote|bateria)/, 'peca'],
  // 'moto' precisa de fronteira à direita: sem ela "Motoniveladoras" virava moto.
  [/\b(motos?\b|motocicl|motoneta|scooter|ciclomotor|quadricicl)/, 'moto'],
  [/\b(onibus|microonibus|micro onibus)/, 'onibus'],
  // Plurais da fonte: "Cavalos Mecânicos", "Pás & Carregadeiras", "Tratores".
  [/\b(caminh[oa]|rebocador|cavalos? mecanicos?|truck|bitrem|basculante|betoneira|guindauto|fora de estrada)/, 'caminhao'],
  [/\b(picape|pick ?up|caminhonete)/, 'picape'],
  [/\b(suv|utilitario esportivo|crossover)/, 'suv'],
  [/\b(utilitari|furg[oa]|vans?\b|minivan|ambulanc|kombi)/, 'utilitario'],
  [/\b(reboques?|semi ?reboques?|carretas?|trailer|implemento|prancha|dolly|granel|cacamba|ca[cç]amba|cana picada|bau\b|tanque)/, 'reboque'],
  [/\b(trator|retro|escavadeira|empilhadeira|paleteira|colheitadeira|maquina|motoniveladora|carregadeira|plantadeira|pulverizador|agricola|pesada)/, 'maquina'],
  [/\b(barco|lancha|jet ?ski|embarcac|nautic|iate|navio|aeronave)/, 'nautico'],
  // "Pesados" sem nada no título é caminhão — nunca carro. O leilo usa essa
  // categoria para caminhão, reboque e implemento agrícola no MESMO saco, e o
  // padrão anterior jogava os 76 que o título não reconhecia no filtro de
  // veículo leve. Vem depois de máquina, para "Máquinas Pesadas" seguir máquina.
  [/\bpesad[oa]s?\b/, 'caminhao'],
  [/\b(hatch|sedan|station wagon|perua|automove|carro|cupe|conversive|colec)/, 'carro'],
];


/**
 * Sinais do TÍTULO fortes o bastante para vencer a categoria da fonte.
 *
 * A categoria às vezes nomeia a CONDIÇÃO, não o tipo: "Sucata de Carros" do
 * Superbid guarda 125 lotes onde entram Honda CG, Montana, Triton e D20 juntos,
 * e o filtro "carro" passava a devolver moto. Só entra aqui padrão que não pode
 * ser um ano nem palavra comum de anúncio — por isso "2008" (que é ano) e "fan"
 * (que no índice só aparece colado ao CG) ficaram de fora.
 */
const TITULO_FORTE: Array<[RegExp, VehicleType]> = [
  // A ordem foi tirada do diff real, não do senso comum. Máquina agrícola vem
  // primeiro porque a marca dela colide com nome de picape: "Pulverizador
  // MONTANA RANGER", "Roçadeira TRITON", "Minicarregadeira NEW HOLLAND L200".
  [/\b(retroescavadeira|escavadeira|motoniveladora|empilhadeira|colheitadeira|plantadeira|semeadeira|adubadeira|pulverizador|ro[cç]adeira|carregadeira|minicarregadeira|rolo compactador|(?<!caminhao )trator)\b/, 'maquina'],
  // Implemento agrícola e de obra. MEDIDO em 17/09: 76 lotes de leilo/"Pesados"
  // — plataforma de corte, semeadora, plaina, grade — caíam no padrão `carro` e
  // apareciam no filtro de veículo leve. "semeadora" não é erro de digitação de
  // "semeadeira": a fonte escreve das duas formas e só a segunda estava aqui.
  // Sigla solta ficou de fora: "magnum" e "hitech" são trator E outras coisas.
  [/\b(plataforma (de )?(corte|milho|graos|cereais)|plataforma (draper|flexivel)|draper|terraflex|acabadora de asfalto|plaina|semeadora|escarificador|grade (aradoura|niveladora|nivelador)|arado|aplicador de bioinsumos|rolo tandem|valtra|plantedaeira)\b/, 'maquina'],
  [/\b(lancha|jet ?ski|embarcacao|iate|veleiro)\b/, 'nautico'],
  // Ônibus antes de caminhão: "ÔNIBUS SCANIA MODELO COMIL" tem as duas marcas.
  // "MPOLO" e "M.POLO" são como o vlance abrevia Marcopolo.
  [/\b(onibus|micro ?onibus|marcopolo|m ?\.? ?polo|mpolo|comil|neobus|busscar|paradiso|volksbus|ciferal|masca|o 4\d{2} (rs|rse))\b/, 'onibus'],
  // Família que no Brasil só existe em caminhão. "AX0R" com zero no lugar do O
  // aparece cru no vlance. "Titan" ficou de fora: é VW 19.320 Titan e Honda CG
  // 125 Titan ao mesmo tempo — o CG já é pego pela regra de moto.
  // Reboque estrutural antes de caminhão: "SEMIRREBOQUE BASCULANTE" também traz
  // marca de pesado no título. "R/" e "SR/" são o prefixo de reboque e
  // semirreboque no RENAVAM, e é assim que vlance e soleon escrevem o título.
  // "Randon" e "prancha" ficaram de fora: a Randon também fabrica
  // retroescavadeira e prancha é carroceria de caminhão, não reboque.
  [/^(r|sr|reb) [a-z]/, 'reboque'],
  // "facchini" ficou de fora pelo mesmo motivo que "Randon" já estava: a marca
  // fabrica semirreboque E carroceria de caminhão, e o dry-run flagrou
  // "Caminhão Mercedes Benz 1718 com baú da marca Facchini" virando reboque.
  // O código do modelo ("SRF") discrimina; o nome do fabricante, não.
  [/\b(semi ?reboque|semirreboque|srf\b|estrada cg)\b/, 'reboque'],
  [/\b(caminh[oa]o|scania|atego|ax[o0]r|accelo|actros|arocs|constellation|worker|tector|eurocargo|stralis|daf ?xf|man ?tg|volkswagen \d{1,2} \d{3}[a-z]?|mb ?\d{4}|f ?4000|cavalo mecanico|bitrem|rodotrem)\b/, 'caminhao'],
  // Linha "L" da Mercedes-Benz por extenso (não abreviada "MB"): achado em
  // 24/09, "Mercedes-Benz/L-2013" no vlance virava carro — sem categoria de
  // fonte, nada no dicionário via o "L" solto como sinal de caminhão.
  [/\bmercedes\b.{0,20}?\bl\s?(1[0-9]{3}|2[0-9]{3})\b/, 'caminhao'],
  // "VW/8.140" e "VW/8.150E" (prefixo de 1 dígito, série 140/Delivery) saíam
  // do "vw ?\d{2} ?\d{3}\b" de cima: exigia 2 dígitos, e o "\b" final falhava
  // quando o sufixo vem colado a letra ("150E"). Achado em 24/09 no bomvalor,
  // categoria da fonte "Hatchback". O espaço ENTRE prefixo e sufixo é
  // obrigatório — sem isso o dry-run pegou "VW, 1990/1991" (Parati, Fusca,
  // Kombi) casando o ANO como se fosse código de caminhão via backtracking.
  [/\bvw\s?([1-9]\d?)\s(\d{3})(?!\d)/, 'caminhao'],
  [/\b(carreta|graneleiro)\b/, 'reboque'],
  [/\b(motocicleta|motoneta|scooter|ciclomotor|quadriciclo)\b/, 'moto'],
  [/\b(cg ?1[1-6]\d|cb ?\d{3}|cbr ?\d{3}|biz|pop ?1[01]0|fan ?125|bros|xre ?\d{3}|nxr|pcx|nmax|burgman|hornet|twister|fazer|ybr ?\d{2,3}|factor ?\d{3}|xj6|xtz ?\d{3}|crosser|lander|tenere|ninja ?\d{3}|shineray|haojue|dafra|kasinski)\b/, 'moto'],
  // "HONDA/CG" sem número (vlance não classifica) ou "125FAN" colado (o "\b"
  // acima falha sem espaço) ficavam carro. "CG" sozinho é ambíguo demais pra
  // valer sem a marca do lado — por isso não entra solto na lista de cima.
  [/\bhonda\b.{0,15}?\bcg\b/, 'moto'],
  [/\b(hilux|s ?10|ranger|amarok|strada|saveiro|montana|l ?200|frontier|oroch|triton|hoggar|rampage|dakota|courier|f ?250|ram ?\d{4}|d ?20|c ?10|toro)\b/, 'picape'],
  [/\b(sw ?4|tucson|ix ?35|creta|tracker|renegade|compass|kicks|duster|captur|t ?cross|nivus|pulse|fastback|tiggo|hr ?v|wr ?v|cr ?v|rav ?4|ecosport|outlander|sportage|xc ?[469]0|tiguan|taos|territory|commander|bronco|jimny|corolla cross|pajero|trailblazer|sorento|santa fe|grand cherokee|cherokee|land cruiser|discovery|evoque)\b/, 'suv'],
  [/\b(sprinter|ducato|daily|jumper|boxer|kangoo|partner|doblo|fiorino|transit|kombi|ambulancia|expert|jumpy|scudo)\b/, 'utilitario'],
];

/**
 * O tipo que o título afirma sozinho, ou null. Exportado para o backfill:
 * reclassificar a base inteira por classifyAsset seria arriscado, porque
 * `sourceGroup` não é persistido e linhas que dependiam dele cairiam no padrão.
 */
/**
 * Categorias que NÃO discriminam o tipo — nelas o título decide.
 *
 * "Carros" é o balaio de veículo leve do Superbid e do Leilo: "Sucata de
 * Carros" guarda 125 lotes com moto, picape e D20 juntos, e o filtro de carro
 * devolvia Honda CG. "Pesados" é o mesmo problema do outro lado: 229 lotes com
 * caminhão, reboque e colheitadeira no mesmo saco.
 */
const GENERICAS = /\b(carros?|pesad[oa]s?|diversos|outros|veiculos?|geral)\b/;

/**
 * "Peças de Máquinas Pesadas" contém "pesadas" e NÃO é genérica: é uma
 * categoria específica — peça. O dry-run pegou isto: sem a exclusão, o título
 * "RODANTE DE FERRO DE ESCAVADEIRA" sobrescrevia peça com máquina e 36 peças
 * do Superbid entravam no índice como máquina inteira.
 */
const categoriaGenerica = (cat: string) => GENERICAS.test(cat) && !/\bpe[cç]a/.test(cat);

export function tipoForteDoTitulo(titleRaw: string, sourceCategory?: string | null): VehicleType | null {
  const cat = fold(sourceCategory ?? '');
  const titulo = fold(titleRaw);
  if (MARCADORES_IMOVEL.test(titulo) || looksLikePart(titleRaw)) return null;
  // Só no INÍCIO do título: "caminhão" solto no meio ("peças PARA caminhão",
  // "retirada DE caminhão", "APLI.: caminhão") descreve o que a peça serve,
  // não o que o lote é — dry-run pegou 7 peças virando veículo inteiro antes
  // desta amarra. No início é sempre o bem em si (achado em 23/09: Superbid
  // "Motos" e bomvalor "Carreta com 3 eixos" categorizando caminhão errado).
  if (/^caminhao\b/.test(titulo)) return 'caminhao';
  let tipoCat: VehicleType | null = null;
  for (const [re, tipo] of CATEGORIA_FONTE) {
    if (cat && re.test(cat)) {
      tipoCat = tipo;
      break;
    }
  }
  // O título só corrige a categoria quando ela NÃO discrimina o tipo. Categoria
  // específica ("Cavalos Mecânicos", "Motoniveladoras") é mais confiável que
  // qualquer palavra do título e não é sobrescrita: o diff mostrou que
  // sobrescrever transformava pulverizador em picape e ônibus em caminhão.
  //
  // O teste é pela CATEGORIA CRUA, não pelo tipo a que ela foi mapeada: desde
  // que "Pesados" passou a cair em `caminhao` (em vez do padrão `carro`),
  // testar o tipo mapeado teria bloqueado o título e transformado as 124
  // colheitadeiras e plantadeiras dessa categoria em caminhão.
  // Duas portas, não uma: o tipo MAPEADO ser `carro` (que cobre "Hatches",
  // "Sedans", "Sucata de Carros" — categorias cujo nome não diz "carro") OU a
  // categoria CRUA ser genérica (que cobre "Pesados", cujo tipo mapeado agora é
  // `caminhao`). Trocar a primeira pela segunda fez um CR-V em "Hatches" perder
  // o `forte` e cair na regra do ano — o dry-run pegou.
  if (tipoCat !== null && tipoCat !== 'carro' && !categoriaGenerica(cat)) return null;
  for (const [re, tipo] of TITULO_FORTE) if (re.test(titulo)) return tipo;
  return null;
}

/** Palavras do TÍTULO quando a fonte não classifica (Kuss e Freitas não classificam). */
const TITULO_TIPO: Array<[RegExp, VehicleType]> = [
  [/\b(cg ?1[26]0|biz|pop ?110|fan|titan|bros|xre|factor|fazer|ybr|pcx|nmax|cb ?\d{3}|xj6|hornet|twister|burgman|dafra|haojue|shineray)\b/, 'moto'],
  [/\b(motocicleta|motoneta|scooter)\b/, 'moto'],
  // Scania, DAF, MAN e Agrale só fazem pesado no Brasil: a marca sozinha decide.
  [/\b(scania|daf|man tg|agrale|atego|axor|accelo|actros|constellation|cargo|worker|vw ?\d{2} ?\d{3}|volkswagen \d{1,2} \d{3}[a-z]?|mb ?\d{4}|fh ?\d{3}|r440|p310|tector|bitrem|cavalo mecanico)\b/, 'caminhao'],
  [/\b(onibus|microonibus|marcopolo|comil|neobus)\b/, 'onibus'],
  [/\b(hilux|s10|ranger|amarok|toro|strada|saveiro|montana|l200|frontier|oroch|maverick|f ?250|d20|courier)\b/, 'picape'],
  [/\b(sprinter|master|ducato|daily|jumper|boxer|kangoo|partner|doblo|fiorino|transit|kombi|ambulancia)\b/, 'utilitario'],
  // "2008" e "3008" só valem colados à marca: sozinhos casavam com ANO/MODELO
  // 2008 e transformaram 30 lotes (inclusive uma retroescavadeira) em SUV.
  [/\b(peugeot[ /-]*[23]008|creta|tracker|renegade|compass|kicks|duster|captur|t ?cross|nivus|pulse|fastback|tiggo|hr ?v|wr ?v|cr ?v|tucson|ix35|sw4|rav4|ecosport|asx|outlander|sportage|xc40|xc60|tiguan|taos|territory|commander|bronco|jimny|corolla cross)\b/, 'suv'],
  [/\b(reboque|semirreboque|semi ?reboque|carreta|randon|trailer)\b/, 'reboque'],
  [/\b(trator|retroescavadeira|escavadeira|empilhadeira|colheitadeira|motoniveladora)\b/, 'maquina'],
  [/\b(lancha|barco|jet ?ski|embarcacao)\b/, 'nautico'],
];

const MARCADORES_IMOVEL =
  /\b(apartamento|casa|terreno|lote urbano|sala comercial|imovel|imoveis|gleba|chacara|fazenda|sitio|galpao|loja|kitnet|sobrado|predio|vaga de garagem|area rural|matricula \d)\b/;

/**
 * Classifica o lote. `sourceCategory` é o rótulo que a própria fonte dá
 * (Copart: "Automóveis"; Superbid: "Hatches"; Leilo: "Carros").
 */
/**
 * Chave de cidade: sem acento, sem caixa, sem espaço duplicado.
 * A mesma cidade chega escrita de até três jeitos entre as fontes ("CUIABA",
 * "CUIABÁ", "Cuiabá"), e comparar a grafia crua transforma um filtro de cidade
 * em três opções que dividem o resultado sem avisar ninguém.
 */
export function chaveCidade(city?: string | null): string | null {
  const t = String(city ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

export const PROPERTY_TYPE_LABEL: Record<string, string> = {
  apartamento: 'Apartamento',
  casa: 'Casa / sobrado',
  terreno: 'Terreno / lote',
  comercial: 'Comercial',
  rural: 'Rural',
  vaga: 'Vaga de garagem',
  outro: 'Outro',
};

/**
 * Categoria da fonte primeiro, título como último recurso. A ordem dentro da
 * lista importa: "Terrenos Rurais" tem de cair em rural antes de bater em
 * terreno, e "sala comercial" antes de "sala" sozinha.
 *
 * Medido nas 4 fontes de imóvel: Caixa já entrega 5 valores normalizados e
 * Superbid uns 20; vlance publica só "imovel" para os 1.208 lotes dele e
 * leilaopro não publica nada, então esses dois dependem do título.
 */
const CATEGORIA_IMOVEL: [RegExp, PropertyType][] = [
  // "hectare" e "faz." apareceram em lote de fração ideal que não diz o tipo
  // em nenhum outro lugar ("Parte Ideal correspondente a 2,72 hectares").
  [/\b(fazenda|faz\.|sitio|chacara|gleba|rural|agricol|pastagem|haras|hectare)/, 'rural'],
  // "BOX Nº 11 DO EDIFÍCIO" é vaga/depósito em edital; "box" sozinho não serve,
  // porque aparece em descrição de banheiro.
  [/\b(vaga|garagem|box\s*n[ºo°]?\.?\s*\d|box\s+\d)/, 'vaga'],
  [/\b(apart|apto|kitnet|kitinete|flat|studio|cobertura|duplex|triplex)/, 'apartamento'],
  [/\b(casa|sobrado|residencia|moradia|geminad)/, 'casa'],
  [/\b(terreno|lote|area de terra|data de terra|quadra)/, 'terreno'],
  [/\b(sala|loja|conjunto comercia|galp[ao]|predio|comercia|escritorio|industria|fabrica|barrac[ao]|pavilh[ao]|hotel|pousada|posto|clinica)/, 'comercial'],
];

export function classifyProperty(
  titleRaw: string,
  sourceCategory?: string | null,
): PropertyType | null {
  const cat = fold(sourceCategory ?? '');
  // "imovel" puro não classifica nada — é o que o vlance manda em 100% dos
  // lotes dele. Tratar como categoria válida faria todos virarem "outro".
  if (cat && !/^imove(l|is)$/.test(cat.trim())) {
    for (const [re, tipo] of CATEGORIA_IMOVEL) if (re.test(cat)) return tipo;
  }
  const titulo = fold(titleRaw);
  for (const [re, tipo] of CATEGORIA_IMOVEL) if (re.test(titulo)) return tipo;
  return null;
}

export function classifyAsset(
  titleRaw: string,
  sourceCategory?: string | null,
  /**
   * Categoria de nível acima, quando a fonte tem duas. A subcategoria do Superbid
   * é aberta demais ("Rolos Compactadores", "Transbordos", "Plataformas") e não
   * cabe em dicionário; sem esse fallback ela caía no padrão e virava carro.
   */
  fallbackCategory?: string | null,
): { assetType: AssetType; vehicleType: VehicleType | null } {
  const cat = fold(sourceCategory ?? '');
  const titulo = fold(titleRaw);

  if (cat) {
    if (/\b(imove|apartament|casa|terreno|sala|loja|gleba|fazenda|sitio|chacara|galp[ao]|predio|sobrado|vaga|rural|comercia|residencia|industria)/.test(cat)) {
      return { assetType: 'imovel', vehicleType: null };
    }
  }

  // O título corrige a categoria genérica — a regra inteira vive em tipoForteDoTitulo.
  const forte = tipoForteDoTitulo(titleRaw, sourceCategory);
  if (forte) return { assetType: 'veiculo', vehicleType: forte };

  if (cat) {
    for (const [re, tipo] of CATEGORIA_FONTE) {
      if (re.test(cat)) return { assetType: tipo === 'peca' ? 'outro' : 'veiculo', vehicleType: tipo };
    }
  }

  // Subcategoria não reconhecida: usa o grupo da fonte antes de chutar.
  const fb = fold(fallbackCategory ?? '');
  if (fb) {
    if (/\b(imove)/.test(fb)) return { assetType: 'imovel', vehicleType: null };
    for (const [re, tipo] of CATEGORIA_FONTE) {
      if (re.test(fb)) return { assetType: tipo === 'peca' ? 'outro' : 'veiculo', vehicleType: tipo };
    }
  }

  if (!cat && MARCADORES_IMOVEL.test(titulo)) {
    return { assetType: 'imovel', vehicleType: null };
  }
  if (looksLikePart(titleRaw)) {
    return { assetType: 'outro', vehicleType: 'peca' };
  }
  for (const [re, tipo] of TITULO_TIPO) {
    if (re.test(titulo)) return { assetType: 'veiculo', vehicleType: tipo };
  }

  // As palavras genéricas ("caminhão", "ônibus", "trator") só existiam no
  // dicionário da CATEGORIA da fonte. Fonte que não classifica (serrano, kuss)
  // caía direto no padrão e virava carro — 41 caminhões e ônibus entraram assim.
  // O mesmo dicionário passa a valer para o título, menos a linha de peça, que
  // já é tratada por looksLikePart acima e daria falso positivo aqui.
  for (const [re, tipo] of CATEGORIA_FONTE) {
    if (tipo === 'peca') continue;
    if (re.test(titulo)) return { assetType: 'veiculo', vehicleType: tipo };
  }

  return { assetType: 'veiculo', vehicleType: 'carro' };
}

export const VEHICLE_TYPE_LABEL: Record<string, string> = {
  carro: 'Carro',
  suv: 'SUV',
  picape: 'Picape',
  moto: 'Moto',
  caminhao: 'Caminhão',
  onibus: 'Ônibus',
  utilitario: 'Utilitário / Van',
  maquina: 'Máquina',
  reboque: 'Reboque',
  nautico: 'Náutico',
  peca: 'Peça',
  outro: 'Outro',
};
