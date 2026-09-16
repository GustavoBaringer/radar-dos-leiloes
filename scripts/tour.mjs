import { chromium } from 'playwright-core';
const EXE = '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => r.status() >= 400 && r.url().includes('localhost:4500') && errors.push(`http ${r.status()}: ${r.url().slice(0,80)}`));

await page.goto('http://localhost:4500/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/leilao-shots/1-home.png' });
console.log('home: total=', await page.locator('#total').textContent(), 'cards=', await page.locator('.card').count());

await page.fill('#q', 'hb20');
await page.click('.searchbar button');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/leilao-shots/2-busca.png' });
console.log('busca hb20: total=', await page.locator('#total').textContent(), '| interpretado:', (await page.locator('#interpreted').textContent()).trim());

await page.locator('.card').first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/leilao-shots/3-detalhe.png' });
console.log('drawer aberto:', await page.locator('#drawer.open').count(), '| linhas:', await page.locator('.kv dt').count());
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await page.click('nav.tabs button[data-view="cobertura"]');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/leilao-shots/4-cobertura.png' });
console.log('cobertura: stats=', await page.locator('.stat').count(), '| linhas por fonte=', await page.locator('#bysource tr').count());

const mob = await browser.newPage({ viewport: { width: 400, height: 860 } });
await mob.goto('http://localhost:4500/', { waitUntil: 'networkidle' });
await mob.waitForTimeout(1200);
await mob.screenshot({ path: '/tmp/leilao-shots/5-mobile.png' });
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log('mobile 400px: scroll horizontal =', overflow);

console.log(errors.length ? 'PROBLEMAS:\n - ' + errors.join('\n - ') : 'sem erros de console/rede');
await browser.close();
