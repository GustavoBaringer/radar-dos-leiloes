import assert from 'node:assert/strict';
import { DAILY_SITES, dailyScheduleItems, dailySite } from '../src/queue/daily-coverage.js';
import { executeCollection, type CollectionExecutionDependencies } from '../src/core/collection-execution.js';
import { dailyConnector } from '../src/queue/daily-worker.js';
import { isBlockedPage } from '../src/connectors/htmlagenda.js';
import { lerCards, judicialAssetTitle } from '../src/connectors/soleon.js';
import { coliseumEvents, mapColiseumLot } from '../src/connectors/coliseum-public.js';
import * as cheerio from 'cheerio';

const schedules = dailyScheduleItems();
assert.equal(DAILY_SITES.filter(s => s.required120).length, 120);
assert.equal(new Set(schedules.map(s => s.id)).size, DAILY_SITES.length);
for (const site of DAILY_SITES) {
  const agenda = schedules.find(s => s.data.tenant === site.domain)!;
  assert.equal(agenda.data.sourceId, site.sourceId);
  const [minute,hour,day,month,weekday] = agenda.pattern.split(' ');
  assert.ok(+minute < 60 && +hour < 24);
  assert.deepEqual([day,month,weekday], ['*','*','*']);
}
assert.throws(() => dailySite('arbitrary.example'), /Unreviewed/);
assert.equal(dailySite('venda-imoveis.caixa.gov.br').required120, true);
assert.equal(dailySite('comprei.pgfn.gov.br').monitorOnly, true);
assert.equal(dailySite('vlleiloes.com.br').sourceId, 'suporteleiloes');
assert.equal(dailySite('celsocunhaleiloes.com.br').sourceId, 'celsocunha');
assert.equal(dailySite('ghvmleiloes.com.br').sourceId, 'ghvmpublic');
assert.equal(dailySite('portaldosleiloes.com.br').sourceId, 'portalpublic');

for (const mode of ['selection-error','empty','persistence-error','success'] as const) {
  const order: string[] = []; const states: any[] = []; const runs: any[] = [];
  const dependencies: CollectionExecutionDependencies = {
    startRun: async () => { order.push('run'); return 1; },
    finishRun: async (_,data) => { runs.push(data); },
    observerForCollection: () => ({ async start(domain: string) {
      assert.equal(domain,'cassianoleiloes.com.br'); order.push('attempt');
      return { response(status: number) { order.push(`http:${status}`); }, failure(kind: string) { order.push(`failure:${kind}`); },
        async finish(stats: any) { states.push(stats); order.push('finish-attempt'); } };
    } }),
    lookupConnector: () => ({ def: { id:'soleon',name:'test',method:'html',tier:1,siteUrl:'https://cassianoleiloes.com.br' }, async collect() {
      order.push('collect');
      if (mode==='selection-error') throw new Error('tenant not selected');
      return { lots: [], fetched: 0, skipped: 0, httpStatus:200 };
    } }),
    upsertLots: async () => { order.push('persist'); if (mode==='persistence-error') throw new Error('write failed'); return { upserted:0,novos:[],bidChanges:[] }; },
    processarAposColeta: async () => ({ disparos:0,push:0,emails:0,pendentesEmail:0 }),
  };
  const call = executeCollection({sourceId:'soleon',tenant:'cassianoleiloes.com.br',limit:10,forceTenantObserver:true,guaranteeTenantAttempt:true},dependencies);
  if (mode.endsWith('error')) await assert.rejects(call);
  else await call;
  assert.deepEqual(order.slice(0,3),['run','attempt','collect']);
  assert.equal(states.length,1);
  assert.equal(runs[0].ok,!mode.endsWith('error'));
  if (mode==='selection-error') assert.ok(order.includes('failure:parser'));
  else assert.ok(order.indexOf('finish-attempt')>order.indexOf('persist'));
  if (mode==='empty') assert.ok(order.includes('http:200'));
}

const native:any = { def:{id:'soleon'}, collect:async()=>({lots:[{lotUrl:'https://cassianoleiloes.com.br/item/1'},{lotUrl:'https://other.example/item/2'}],fetched:2,skipped:0}) };
const adapter = dailyConnector('cassianoleiloes.com.br',()=>native,async()=>true);
const filtered = await adapter.collect({limit:100});assert.equal(filtered.lots.length,1);assert.equal(filtered.skipped,1);
const disabled = dailyConnector('cassianoleiloes.com.br',()=>native,async()=>false);
await assert.rejects(disabled.collect({limit:1}), /disabled/);

assert.equal(isBlockedPage('<title>Coliseum</title><script>grecaptcha.render()</script><p>Lista de lotes</p>'),false);
assert.equal(isBlockedPage('<h1>Sistema indisponível</h1>'),true);
assert.equal(isBlockedPage('<title>Just a moment</title>'),true);
const cards=lerCards(cheerio.load('<div class="lote"><h5>Lote em Leilão Judicial</h5><a href="/item/1/detalhes"></a><div style="text-align:justify">Descrição: Processo judicial. Descrição do bem: Veículo Fiat Freemont</div></div>'),'leilaopernambuco.com.br');
assert.match(cards[0].titulo,/Fiat Freemont/);
const detail=judicialAssetTitle('<p>Descrição: RECLAMANTE Fulano. Descrição do bem: caminhão, placa QYC-9711/PE, marca Iveco, modelo Stralis 800S48TZ, ano 2019/2020. Localização: Recife</p>');
assert.match(detail!,/Iveco/);assert.ok(!detail!.includes('Fulano'));assert.ok(!detail!.includes('QYC'));
assert.deepEqual(coliseumEvents('<a href="listar-lotes.php?codLeilao=1209">Ver lotes</a><a href="https://other.example/site/listar-lotes.php?codLeilao=1">Outro</a>'),['1209']);
const lot=mapColiseumLot({id:'264460',marcaModelo:'HONDA/Pop 100',ano:'2007/2007',foto:'../imgTmp/photo.jpg'},'1209')!;
assert.equal(lot.sourceId,'coliseumpublic');assert.equal(lot.yearModel,2007);assert.match(lot.lotUrl!,/codLote=264460/);assert.equal(lot.photos?.[0],'https://www.coliseumleiloes.com.br/imgTmp/photo.jpg');
assert.equal(mapColiseumLot({id:'0',marcaModelo:''},'1209'),null);
console.log('Daily scope, scheduling, guaranteed ledger, failure/empty outcomes, tenant isolation and parser regressions OK');
