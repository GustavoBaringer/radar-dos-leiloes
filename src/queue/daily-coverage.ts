export interface DailySite { domain: string; sourceId: string; required120: boolean; monitorOnly?: boolean }

// Frozen audit scope: 120 stale hosts plus the user-requested PE/SE/PB sites.
export const DAILY_SITES: readonly DailySite[] = [
  {
    "domain": "abaleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": false
  },
  {
    "domain": "abrantesleiloes.com",
    "sourceId": "leilotech",
    "required120": false
  },
  {
    "domain": "absolutaleiloes.com.br",
    "sourceId": "suaplataforma",
    "required120": true
  },
  {
    "domain": "albuquerqueleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": false,
    "monitorOnly": true
  },
  {
    "domain": "alinemarquesleiloeira.lel.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "amaralleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "aplleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "aragaoleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "argleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "arnaldoleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "arremateleiloes.com.br",
    "sourceId": "portalzuk",
    "required120": false,
    "monitorOnly": true
  },
  {
    "domain": "atlanticoleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": false
  },
  {
    "domain": "auroraleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "barretoleiloes.com.br",
    "sourceId": "suaplataforma",
    "required120": true
  },
  {
    "domain": "beatrizmussaleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "bessaleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "biasileiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "bidmax.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "bl.leilao.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "brunoniewinskileiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "c3leiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": false
  },
  {
    "domain": "calilleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "cardosoleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "cassianoleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "ccjleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "celsocunhaleiloes.com.br",
    "sourceId": "celsocunha",
    "required120": false
  },
  {
    "domain": "cencin.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "chbarbosaleiloes.com.br",
    "sourceId": "suaplataforma",
    "required120": true
  },
  {
    "domain": "coliseumleiloes.com.br",
    "sourceId": "coliseumpublic",
    "required120": false
  },
  {
    "domain": "colodeteleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "colossoleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": false
  },
  {
    "domain": "comprei.pgfn.gov.br",
    "sourceId": "globoleiloes",
    "required120": true,
    "monitorOnly": true
  },
  {
    "domain": "compreipgfn.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "diasleiloes.com.br",
    "sourceId": "vlance",
    "required120": true
  },
  {
    "domain": "donizetteleiloes.leilao.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "dsleiloes.com.br",
    "sourceId": "leilotech",
    "required120": true
  },
  {
    "domain": "ericosobral.com.br",
    "sourceId": "vipleiloes",
    "required120": false
  },
  {
    "domain": "fabiobarbosaleiloes.com.br",
    "sourceId": "vlance",
    "required120": false
  },
  {
    "domain": "facanhaleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "fernandaleiloes.lel.br",
    "sourceId": "leilaopro",
    "required120": true
  },
  {
    "domain": "ferreiraleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "ferronato.leilao.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "ferronatoleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "flaviocostaleiloes.com.br",
    "sourceId": "leiloar",
    "required120": false
  },
  {
    "domain": "focoleileos.com.br",
    "sourceId": "htmlagenda",
    "required120": false,
    "monitorOnly": true
  },
  {
    "domain": "focoleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "gbleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "geilsonalmeidaleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "ghvmleiloes.com.br",
    "sourceId": "ghvmpublic",
    "required120": false
  },
  {
    "domain": "gracieleiloes.com.br",
    "sourceId": "suaplataforma",
    "required120": false
  },
  {
    "domain": "gustavoreisleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "gutembergaraujoleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "ibecleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "ileiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "inovaleilao.com.br",
    "sourceId": "suaplataforma",
    "required120": false
  },
  {
    "domain": "isabelleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "isaiasleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "jdleiloes.com.br",
    "sourceId": "vlance",
    "required120": false
  },
  {
    "domain": "joaoemilio.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "josenildolimaleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": false,
    "monitorOnly": true
  },
  {
    "domain": "joserodovalholeiloes.com.br",
    "sourceId": "vlance",
    "required120": false
  },
  {
    "domain": "kildareleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "lancecertoleiloes.com.br",
    "sourceId": "vipleiloes",
    "required120": false
  },
  {
    "domain": "lancejudicial.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "lancemaiorleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "lancese.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "lancevip.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "lecapeleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "leffaleiloes.com.br",
    "sourceId": "leilaopro",
    "required120": true
  },
  {
    "domain": "leilaobrasil.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "leilaoeletronico.com.br",
    "sourceId": "suaplataforma",
    "required120": true
  },
  {
    "domain": "leilaopernambuco.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "leiloeirojudicial.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "leiloes-sc.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "leiloesbrasilcassiano.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "leiloesbrasilpe.com.br",
    "sourceId": "htmlagenda",
    "required120": false
  },
  {
    "domain": "leiloescostaesilva.com.br",
    "sourceId": "htmlagenda",
    "required120": false
  },
  {
    "domain": "leiloesfreire.com.br",
    "sourceId": "leiloesfreire",
    "required120": false
  },
  {
    "domain": "leiloesgold.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "leiloesja.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "leiloeslaraforster.com.br",
    "sourceId": "docxhtml",
    "required120": true
  },
  {
    "domain": "leiloesmonteiro.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "leiloespb.com.br",
    "sourceId": "suporteleiloes",
    "required120": false
  },
  {
    "domain": "leiloesrn.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "leiloestocantins.com",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "leiloesuberlandia.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "leilopar.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "levyleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "liderleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "luisleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "luizlobatoleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "lutheroleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "maglianoleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": false
  },
  {
    "domain": "maisleilao.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "maraurzedoleilao.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "marcaleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "marcoantonioleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "marcotulioleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": false
  },
  {
    "domain": "marianoleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "marioricart.lel.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "marquesbarretoleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "martinsleiloes.com.br",
    "sourceId": "bomvalor",
    "required120": true
  },
  {
    "domain": "medeirosleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "melissasoaresleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "mjleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "mpleilao.com.br",
    "sourceId": "leilaopro",
    "required120": true
  },
  {
    "domain": "multleiloes.com",
    "sourceId": "bomvalor",
    "required120": true
  },
  {
    "domain": "nossoleilao.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "nsleiloes.leilao.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "nsleiloes.lel.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "octavioleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "oliveiraleilao.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "oroleiloes.lel.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "oscarleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "pamelaleiloeira.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "patiorochaleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "peterlongo.leilao.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "portalbayit.com.br",
    "sourceId": "suaplataforma",
    "required120": true
  },
  {
    "domain": "portaldosleiloes.com.br",
    "sourceId": "portalpublic",
    "required120": false
  },
  {
    "domain": "purcenaleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "rabuskeleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "rafaelaribeiroleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "rafaelcoutinho.lel.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "rafaelleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "realizaleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "rechleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "renannerisleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "ricoleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "rjleiloes.com.br",
    "sourceId": "soleon",
    "required120": false
  },
  {
    "domain": "rodrigocostaleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "rodrigoleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "rofremleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "rogeriomenezes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "rogerserafimleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "rymerleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "sandrasantosleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "sandroleiloeiro.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "santiagoleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "saraivaleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "sbleiloes.lel.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "serpaleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "sevidanesleiloeira.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "srleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "stefanellileiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "suedpeterleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "sydneyleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "tbaracajuleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": false
  },
  {
    "domain": "tmleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "tribunaleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "valeroleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "vecchileiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "vegasleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "venda-imoveis.caixa.gov.br",
    "sourceId": "caixa",
    "required120": true
  },
  {
    "domain": "vixleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "vlleiloes.com.br",
    "sourceId": "suporteleiloes",
    "required120": true
  },
  {
    "domain": "wrleiloes.com.br",
    "sourceId": "htmlagenda",
    "required120": true
  },
  {
    "domain": "wspleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  },
  {
    "domain": "zagoleiloes.com.br",
    "sourceId": "soleon",
    "required120": true
  }
];

export function dailySite(domain: string): DailySite {
  const item = DAILY_SITES.find(s => s.domain === domain);
  if (!item) throw new Error(`Unreviewed daily domain: ${domain}`);
  return item;
}

export function dailyScheduleItems() {
  return DAILY_SITES.map((site, index) => {
    const minute = index * 4;
    return { id: `daily-site-${site.domain.replaceAll(".", "-")}`, name: `daily:${site.domain}`,
      pattern: `${minute % 60} ${Math.floor(minute / 60)} * * *`,
      data: { sourceId: site.sourceId, tenant: site.domain, limit: site.sourceId === "caixa" ? 15000 : 1200, timeoutMs: 180000 } };
  });
}
