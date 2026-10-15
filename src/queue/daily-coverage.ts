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
  },
  { "domain": "albertolopesleiloeiro.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "andreadiniz.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "bastosleiloes.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "br.antonioferreira.lel.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "camilaleiloes.com.br", "sourceId": "suporteleiloes", "required120": false },
  { "domain": "carloferrarileiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "depaulaonline.com.br", "sourceId": "suporteleiloes", "required120": false },
  { "domain": "destakleiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "duplaleiloes.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "edgarcarvalholeiloeiro.com.br", "sourceId": "suporteleiloes", "required120": false },
  { "domain": "evanioalvesleiloeiro.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "fabianoayuppleiloeiro.com.br", "sourceId": "suporteleiloes", "required120": false },
  { "domain": "fabioleiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "joaodefrancoleiloeiro.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "jonasleiloeiro.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "jvleiloes.lel.br", "sourceId": "soleon", "required120": false },
  { "domain": "karlapepe.lel.br", "sourceId": "karlapepe", "required120": false },
  { "domain": "leiloeiraerikamaciel.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "leiloesbraga.lel.br", "sourceId": "leiloesbraga", "required120": false },
  { "domain": "leiloeironacif.com", "sourceId": "soleon", "required120": false },
  { "domain": "levyleiloeiro.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "machadoleiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "marciopinho.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "marthapadilhaleiloeira.lel.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "mauriciomarizleiloes.com.br", "sourceId": "suporteleiloes", "required120": false },
  { "domain": "megaleiloes.com.br", "sourceId": "megaleiloes", "required120": false },
  { "domain": "portellaleiloes.com.br", "sourceId": "suporteleiloes", "required120": false },
  { "domain": "positivoleiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "raulbarbosa.lel.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "ricartleiloes.com.br", "sourceId": "suporteleiloes", "required120": false },
  { "domain": "rigolonleiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "rioleiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "sbleiloeiro302.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "silvaleiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "tamiriscarvalholeiloeira.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "tavaresleiloes.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "thaisqueirozleiloeira.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "valdirteixeiraleiloeiro.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "veratostesleiloes.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "vincoleiloes.com.br", "sourceId": "sishp", "required120": false },
  { "domain": "willianmachadoleiloeiro.com.br", "sourceId": "leiloesbr", "required120": false },
  { "domain": "wmsleiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "alexandrecostaleiloes.com.br", "sourceId": "msis", "required120": false },
  { "domain": "analucialeiloeira.com.br", "sourceId": "msis", "required120": false },
  { "domain": "britesleiloeiro.com.br", "sourceId": "msis", "required120": false },
  { "domain": "bspleiloes.com.br", "sourceId": "msis", "required120": false },
  { "domain": "davimattosleiloeiro.com.br", "sourceId": "msis", "required120": false },
  { "domain": "fredericoleiloes.com.br", "sourceId": "msis", "required120": false },
  { "domain": "gabrielleiloeiro.com.br", "sourceId": "msis", "required120": false },
  { "domain": "gpleilao.com.br", "sourceId": "msis", "required120": false },
  { "domain": "leiloeirasilvani.com.br", "sourceId": "msis", "required120": false },
  { "domain": "leiloeirolegentil.com.br", "sourceId": "msis", "required120": false },
  { "domain": "marcoscostaleiloeiro.com.br", "sourceId": "msis", "required120": false },
  { "domain": "mklance.com.br", "sourceId": "msis", "required120": false },
  { "domain": "octaviovianna.lel.br", "sourceId": "msis", "required120": false },
  { "domain": "onildobastos.com.br", "sourceId": "msis", "required120": false },
  { "domain": "pedrocastroleiloes.com.br", "sourceId": "msis", "required120": false },
  { "domain": "ricardocorrealeiloes.com.br", "sourceId": "msis", "required120": false },
  { "domain": "sergiorepresasleiloes.com.br", "sourceId": "msis", "required120": false },
  { "domain": "tostesleiloeiro.com.br", "sourceId": "msis", "required120": false },
  { "domain": "viannaleiloes.com.br", "sourceId": "msis", "required120": false },
  { "domain": "alfaleiloes.com", "sourceId": "alfaleiloes", "required120": false },
  { "domain": "centraldosleiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "clicleiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "cravoleiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "danielgarcialeiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "eustacio.com.br", "sourceId": "htmlagenda", "required120": false },
  { "domain": "falleirosleiloes.com.br", "sourceId": "suaplataforma", "required120": false },
  { "domain": "fernandoleiloeiro.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "franciscofreitasleiloes.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "guariglialeiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "hastaleiloes.com.br", "sourceId": "soleon", "required120": false },
  { "domain": "hatoryleiloes.com.br", "sourceId": "leiloar", "required120": false },
  { "domain": "jussiaraleiloes.com", "sourceId": "leiloar", "required120": false },
  { "domain": "leiloesjudiciaisbahia.com.br", "sourceId": "vlance", "required120": false },
  { "domain": "lucasleiloeiro.com.br", "sourceId": "vlance", "required120": false }
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
