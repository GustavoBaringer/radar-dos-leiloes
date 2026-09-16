/**
 * O toast de encerramento tem de aparecer na tela do admin e NÃO na do usuário
 * comum — mesma regra da telemetria de coleta.
 *
 * O teste publica a mensagem no canal que o worker usa, em vez de esperar um
 * ciclo real: o ciclo roda a cada minuto e quase sempre fecha zero lote, então
 * esperar por ele tornaria o teste lento e intermitente.
 */
import { chromium } from 'playwright-core';
import { entrarComSenha } from './_teste-comum.mjs';
import { makeRedis, CHANNEL_UPDATES } from '../src/queue/queues.ts';

const BASE = process.env.BASE ?? 'http://localhost:4500';
const b = await chromium.launch({ headless: true, executablePath: '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const pub = makeRedis();
const falhas = [];
const ok = (c, m) => (c ? console.log(`  PASSA  ${m}`) : falhas.push(m));

const p = await (await b.newContext()).newPage();
await entrarComSenha(p, BASE);
await p.goto(`${BASE}/busca`);
await p.waitForSelector('#grid .card', { timeout: 20000 });
// Espera o WebSocket abrir antes de publicar, senão a mensagem passa em branco.
await p.waitForFunction(() => window.__wsAberto === true || document.querySelectorAll('#grid .card').length > 0, { timeout: 10000 });
await p.waitForTimeout(1500);

await pub.publish(CHANNEL_UPDATES, JSON.stringify({ type: 'encerrados', total: 37, porPrazo: 30, porAusencia: 7 }));
await p.waitForTimeout(1200);
const textos = await p.$$eval('#toast div', (ns) => ns.map((n) => n.textContent));
console.log('  toasts na tela:', JSON.stringify(textos));
ok(textos.some((t) => /37 lotes encerrados/.test(t)), 'admin vê "37 lotes encerrados"');

// singular
await pub.publish(CHANNEL_UPDATES, JSON.stringify({ type: 'encerrados', total: 1 }));
await p.waitForTimeout(1000);
const t2 = await p.$$eval('#toast div', (ns) => ns.map((n) => n.textContent));
ok(t2.some((t) => /^1 lote encerrado$/.test(t)), `concorda em número no singular (veio ${JSON.stringify(t2)})`);

await pub.quit();
await b.close();
console.log(falhas.length ? `\nFALHOU:\n- ${falhas.join('\n- ')}` : '\nVERDE: o toast de encerramento aparece.');
process.exit(falhas.length ? 1 : 0);
