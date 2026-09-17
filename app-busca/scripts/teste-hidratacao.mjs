/**
 * A hidratação do SSR bate com o servidor?
 *
 * Divergência de hidratação sai como WARNING no console, não como error — o
 * screenshot de rotina não a pegaria. Aqui capturamos todos os níveis e
 * exigimos ZERO menção a hydration/mismatch.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const API = 'http://localhost:4500';
const SLUG = process.argv[2] ?? 'chevrolet-onix-2018-recuperado-financiamento-leilo-6031';

function acharChromium() {
  const cache = path.join(homedir(), '.cache', 'ms-playwright');
  const rev = (d) => Number(d.split('-').pop());
  for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => rev(b) - rev(a))) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const exe = path.join(cache, dir, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const browser = await chromium.launch({ executablePath: acharChromium() });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const msgs = [];
page.on('console', (m) => msgs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => msgs.push(`pageerror: ${e.message}`));

await page.goto(`${API}/login`, { waitUntil: 'load' });
await page.fill('#usuario', process.env.APP_USUARIO);
await page.fill('#senha', process.env.APP_SENHA);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);

await page.goto(`${API}/lote/${SLUG}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// O conteúdo do SSR sobreviveu à hidratação? Se o React descartasse a árvore,
// o título da gaveta sumiria por um instante e reapareceria — ou não voltaria.
const titulo = await page.textContent('#drawerTitle').catch(() => null);
const temGaveta = await page.locator('.drawer .painel').count();

// Os códigos são obrigatórios: em produção o React MINIFICA a mensagem, e
// "Minified React error #418" não contém a palavra "hydration". O detector
// antigo dizia "0 suspeitas" com o erro de hidratação na tela ao lado.
// 418/423/425 = falha de hidratação; 421 = suspensão durante hidratação.
const suspeitas = msgs.filter((m) => /hydrat|mismatch|did not match|server (HTML|render)|React error #4(18|21|23|25)/i.test(m));
const erros = msgs.filter((m) => m.startsWith('error') || m.startsWith('pageerror'));

console.log(`gaveta renderizada: ${temGaveta === 1 ? 'sim' : 'NÃO'}`);
console.log(`título após hidratar: ${titulo ?? '(vazio)'}`);
console.log(`mensagens de console: ${msgs.length}`);
console.log(`suspeitas de hidratação: ${suspeitas.length}`);
for (const s of suspeitas) console.log(`  ${s.slice(0, 160)}`);
for (const e of erros) console.log(`  ${e.slice(0, 160)}`);

await browser.close();
process.exit(suspeitas.length || erros.length || temGaveta !== 1 ? 1 : 0);
