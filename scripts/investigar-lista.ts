import * as fs from 'node:fs';
import * as dns from 'node:dns/promises';
import { pool } from '../src/core/db.js';
import { LOT_SITE_HOST_SQL } from '../src/core/repo.js';
import { DAILY_SITES } from '../src/queue/daily-coverage.js';
import { PLATAFORMAS } from '../src/core/descoberta.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const RAW_INPUTS = [
  "https://www.actleiloes.com.br/",
  "https://www.frazaoleiloes.com.br/",
  "https://www.brunoleiloes.com.br/",
  "https://www.alienajud.com.br/",
  "https://www.sumareleiloes.com.br/",
  "https://www.danielgarcialeiloes.com.br/",
  "https://www.insigneleiloes.com.br/",
  "https://www.doleiloes.com.br/",
  "https://www.portalzuk.com.br/",
  "https://www.douglasleiloeiro.com.br/",
  "https://www.biasileiloes.com.br/",
  "https://www.tribunaleiloes.com.br/",
  "https://www.sudesteleiloes.com.br/",
  "https://leilaoonline.com.br/",
  "https://monago.com.br/",
  "https://www.cardosoleiloes.com.br/",
  "https://www.insigneleiloes.com.br/",
  "www.francoleiloes.com.br",
  "www.gspleiloes.com.br",
  "www.trustbid.com.br",
  "www.alexandridis.leilao.br",
  "www.giordanoleiloes.com.br",
  "www.primeirapraca.com.br",
  "www.gustavomorettoleiloeiro.com.br",
  "www.jrfleiloes.com.br",
  "www.olivirogerioleiloes.com.br",
  "www.leiloessantosmoraes.com.br",
  "www.battaglialeiloeiro.com.br",
  "www.leilaoinvestment.com.br",
  "www.camargonet.leilao.br",
  "www.olivirogerioleiloes.com.br",
  "www.confiancaleiloes.leilao.br",
  "www.bomnegocioleiloes.com.br",
  "www.alienajud.com.br",
  "www.pedrooliveiraleiloeiro.com.br",
  "www.silvaleiloes.com.br",
  "www.leilaoonline.net",
  "www.LeiloeiroPublico.com.br",
  "www.terrabrasilleiloes.com.br",
  "WWW.PETROZINILEILÕES.COM.BR",
  "www.wspleiloes.com.br",
  "www.willianquencaleiloeiro.com.br",
  "https://www.cravoleiloes.com.br/",
  "https://www.tahaleiloes.com.br/",
  "https://www.albertomacedoleiloes.com.br/",
  "https://www.freitasleiloeiro.com.br/",
  "https://www.leiloesjudiciaismg.com.br/",
  "https://www.vivaleiloes.com.br/",
  "https://www.batistaleiloes.com.br/",
  "https://www.zallileiloes.com.br/",
  "https://www.elance.com.br/",
  "https://atomazellileiloeira.com.br/",
  "https://www.planaltoleiloes.com.br/",
  "https://cencin.com.br/",
  "https://www.leilaoeletronico.com.br/",
  "https://www.ricoleiloes.com.br/",
  "https://www.pecinileiloes.com.br/",
  "https://www.saraivaleiloes.com.br/",
  "https://wleiloes.com.br/",
  "https://www.vincoleiloes.com.br/",
  "https://satoleiloes.com.br/",
  "https://www.guariglialeiloes.com.br/",
  "https://www.cidafixerleiloes.com.br/",
  "https://www.savoyleiloes.com.br/",
  "https://www.pestanaleiloes.com.br/",
  "https://www.apabrfleiloes.com.br/",
  "https://www.gfleiloes.com.br/",
  "https://brunoleiloes.com.br/",
  "https://www.nextleiloes.com.br/",
  "https://ctmleiloes.com.br/",
  "https://www.lancenoleilao.com.br/",
  "https://www.carloferrarileiloes.com.br/",
  "https://www.frazaoleiloes.com.br/",
  "https://arremataronline.com.br/",
  "https://www.rmcleiloes.com.br/",
  "https://www.eduardosorgileiloeiro.com.br/",
  "https://www.sodresantoro.com.br/",
  "https://www.liderleiloes.com.br/",
  "https://globoleiloes.com.br/",
  "https://www.leffaleiloes.com.br/",
  "https://www.rocketleiloes.com.br/",
  "https://www.allianceleiloes.com.br/",
  "https://www.clebercardosoleiloes.com.br/",
  "https://www.leilaooficialonline.com.br/",
  "https://www.chuileiloes.com.br/",
  "https://mariafixerleiloes.com.br/",
  "https://magalhaesleiloes.leilao.br/",
  "https://www.goldenlance.com.br/",
  "https://www.lanceleiloes.com.br/",
  "https://www.dbmleiloes.com.br/",
  "https://www.milanileiloes.com.br/",
  "https://milanleiloes.com.br/",
  "https://www.alfaleiloes.com/",
  "https://www.vianaleiloes.com.br/",
  "https://www.fidalgoleiloes.com.br/",
  "https://www.amaralleiloes.com.br/",
  "https://www.clicleiloes.com.br/",
  "https://www.superbid.net/",
  "https://www.hastapublica.com.br/",
  "https://www.unileiloes.com.br/",
  "https://fabiobarbosaleiloes.com.br/",
  "https://www.machadoleiloeiro.com.br/",
  "https://www.desantileiloes.com.br/",
  "https://leiloei.com/",
  "https://www.fernandoleiloeiro.com.br/",
  "https://www.vivaleiloes.com.br/",
  "https://www.franciscofreitasleiloes.com.br/",
  "https://www.zaccarino.com.br/",
  "https://www.maisleilao.com.br/",
  "https://gabrieltorresleiloes.com.br/",
  "https://www.benozzati.com.br/",
  "https://gilsonleiloes.com.br/",
  "https://www.ricoleiloes.com.br/",
  "https://www.rossileiloes.com.br/",
  "https://gustavoreisleiloes.com.br/",
  "https://www.kronleiloes.com.br/",
  "https://www.verrileiloes.com.br/",
  "https://www.vegasleiloes.com.br/",
  "https://www.cunhaleiloeiro.com.br/",
  "https://www.desouzaleiloes.com.br/",
  "https://www.picellileiloes.com.br/",
  "https://www.coimbraleiloes.com.br/",
  "https://www.valeroleiloes.com.br/",
  "https://www.jmfleiloes.com.br/",
  "satoleiloes.com.br/",
  "https://www.calilleiloes.com.br/",
  "bramoleiloes.com.br/",
  "https://www.jussiaraleiloes.com/",
  "https://www.lecapeleiloes.com.br/",
  "https://www.capitalvalorleiloes.com.br/",
  "https://www.sublimeleiloes.com.br/",
  "https://www.bidmax.com.br/",
  "https://www.marangonileiloes.com.br/",
  "https://www.andradeleiloes.com.br/",
  "https://www.pavanileiloes.com.br/",
  "lutheroleiloes.com.br/",
  "https://www.bigleilao.com.br/",
  "https://www.3torresleiloes.com.br/",
  "https://www.destakleiloes.com.br/",
  "leiloesmariafilomena.com.br/",
  "https://www.nacionalleiloes.com.br/",
  "https://www.shiokawaleiloes.com.br/",
  "https://www.glleiloes.com.br/",
  "https://www.mjleiloes.com.br/",
  "https://www.andraleiloes.com.br/",
  "https://www.conceitoleiloes.com.br/",
  "https://www.brancalliao.com.br/",
  "oaleiloes.com.br/",
  "https://www.omcleiloes.com.br/",
  "https://www.nossoleilao.com.br/",
  "https://www.winleiloes.com.br/",
  "https://www.pedrooliveiraleiloeiro.com.br/",
  "https://www.peixotoleiloes.com.br/",
  "https://www.gracieleiloes.com.br/",
  "https://www.faroonline.com.br/",
  "https://www.dantasleiloes.com.br/",
  "https://www.rigolonleiloes.com.br/",
  "https://www.hammer.lel.br/",
  "https://www.maialeiloes.com.br/",
  "https://www.totalleiloes.com.br/",
  "raicherleiloes.com.br/",
  "https://www.sandrasantosleiloes.com.br/",
  "sfleiloes.com.br/",
  "https://www.silvaleiloes.com.br/",
  "editalleiloes.com.br/",
  "https://www.multipliqueleiloes.com.br/",
  "https://www.ktzleiloes.com.br/",
  "https://www.lottileiloes.com.br/",
  "maximoleiloes.com.br/"
];

export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.split('/')[0];
  s = s.split(':')[0];
  s = s.replace(/^www\./, '');
  if (s.includes('petrozini')) return 'petrozinileiloes.com.br';
  try {
    const u = new URL('http://' + s);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return s;
  }
}

async function probeDomain(domain: string) {
  const result: any = {
    domain,
    dnsOk: false,
    testedHost: null,
    httpStatus: null,
    finalUrl: null,
    platform: null,
    title: null,
    hasLotsHint: false,
    error: null,
  };

  let hostToTry = domain;
  try {
    await dns.lookup(domain);
    result.dnsOk = true;
    hostToTry = domain;
  } catch (e1: any) {
    try {
      await dns.lookup('www.' + domain);
      result.dnsOk = true;
      hostToTry = 'www.' + domain;
    } catch (e2: any) {
      result.error = `DNS failure (${e1.code || e1.message})`;
      return result;
    }
  }

  result.testedHost = hostToTry;

  const urlsToTry = [
    `https://${hostToTry}`,
    `https://www.${domain}`,
    `http://${hostToTry}`,
    `http://www.${domain}`,
  ];

  let body = '';
  let status = 0;
  let finalUrl = '';

  for (const url of [...new Set(urlsToTry)]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'pt-BR,pt;q=0.9',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      status = res.status;
      finalUrl = res.url;
      body = await res.text();
      break;
    } catch (err: any) {
      result.error = err.message;
    }
  }

  result.httpStatus = status;
  result.finalUrl = finalUrl;

  if (body) {
    const mTitle = body.match(/<title[^>]*>([^<]+)<\/title>/i);
    result.title = mTitle ? mTitle[1].trim() : null;

    for (const [pName, re] of PLATAFORMAS) {
      if (re.test(body)) {
        result.platform = pName;
        break;
      }
    }

    if (!result.platform) {
      if (body.includes('/core/api/get-lotes') || body.includes('vlance')) result.platform = 'vlance';
      else if (body.includes('d1mdxpzu4pgcoh.cloudfront.net') || body.includes('soleon')) result.platform = 'soleon';
      else if (body.includes('suaplataformadeleilao')) result.platform = 'sua-plataforma';
      else if (body.includes('suporteleiloes') || body.includes('.leilao.br')) result.platform = 'suporte-leiloes';
      else if (body.includes('leilotech')) result.platform = 'leilotech';
      else if (body.includes('leiloar')) result.platform = 'leiloar';
      else if (body.includes('leiloesbr.com.br')) result.platform = 'leiloesbr';
      else if (body.includes('sishp')) result.platform = 'sishp';
      else if (body.includes('portalzuk') || body.includes('zukerman')) result.platform = 'portalzuk';
      else if (body.includes('superbid')) result.platform = 'superbid';
    }

    const SINAL_LOTE = /(lance\s+(inicial|atual|m[ií]nimo)|aberto\s+para\s+lances|lote\s*\d|encerra\s+em|pr[oó]ximos\s+leil[õo]es|dou-lhe)/i;
    result.hasLotsHint = SINAL_LOTE.test(body);
  }

  return result;
}

async function run() {
  const uniqueDomains = [...new Set(RAW_INPUTS.map(normalizeDomain))];
  console.log(`Probing ${uniqueDomains.length} unique domains...`);

  const results: any[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < uniqueDomains.length; i += CONCURRENCY) {
    const chunk = uniqueDomains.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async dom => {
        const t0 = Date.now();
        const p = await probeDomain(dom);
        console.log(`[${dom}] status=${p.httpStatus} platform=${p.platform} (${Date.now() - t0}ms)`);
        return p;
      })
    );
    results.push(...chunkResults);
  }

  fs.writeFileSync(
    'scripts/probe_results.json',
    JSON.stringify(results, null, 2)
  );
  console.log('Saved scripts/probe_results.json');
}

if (process.argv[1]?.endsWith('investigar-lista.ts')) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

