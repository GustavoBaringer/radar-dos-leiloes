/**
 * Screenshot do app de busca autenticado.
 *
 * A busca exige sessão: sem ela o /api/search devolve 401 e o PNG sai com a
 * tela vazia — que passa por "bug de layout" quando é só falta de login.
 *
 * O login acontece no Fastify (4500) e vale no Vite (13000) porque COOKIE NÃO
 * ISOLA POR PORTA: mesmo host, mesmo jar.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL ?? 'http://localhost:13000';
const API = process.env.API_URL ?? 'http://localhost:4500';
const outDir = process.argv[2] ?? 'shots';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

function acharChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return null;
  const rev = (d) => Number(d.split('-').pop());
  for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => rev(b) - rev(a))) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const exe = path.join(cache, dir, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const executablePath = acharChromium();
if (!executablePath) {
  console.error('Chromium não encontrado. Rode: npx playwright@latest install chromium');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath });
const erros = [];

/** Rola a página inteira: fullPage via CDP não gera scroll real, e revelação
    por observador ficaria presa em opacity 0, saindo em branco no PNG. */
const rolar = (page) =>
  page.evaluate(
    () =>
      new Promise((ok) => {
        let y = 0;
        const passo = () => {
          y += 600;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight) setTimeout(passo, 100);
          else {
            window.scrollTo(0, 0);
            setTimeout(ok, 400);
          }
        };
        passo();
      }),
  );

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') erros.push(`[console:${vp.name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => erros.push(`[pageerror:${vp.name}] ${e.message}`));

  await page.goto(`${API}/login`, { waitUntil: 'load' });
  await page.fill('#usuario', process.env.APP_USUARIO);
  await page.fill('#senha', process.env.APP_SENHA);
  await Promise.all([page.waitForNavigation({ timeout: 20_000 }), page.click('button[type=submit]')]);
  if (page.url().includes('/login')) throw new Error(`login falhou: ${page.url()}`);

  const capturar = async (caminho, nome, antes) => {
    await page.goto(`${APP}${caminho}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() =>
      page.goto(`${APP}${caminho}`, { waitUntil: 'load', timeout: 30_000 }),
    );
    await page.waitForTimeout(1500);
    if (antes) await antes(page);
    await rolar(page);
    const arq = path.join(outDir, `${nome}-${vp.name}-${vp.width}.png`);
    await page.screenshot({ path: arq, fullPage: true });
    console.log(`ok ${arq}`);
  };

  await capturar('/busca', 'busca');
  await capturar('/busca', 'gaveta', async (p) => {
    await p.click('.card', { timeout: 10_000 }).catch(() => console.warn('  sem cartão para abrir a gaveta'));
    await p.waitForTimeout(1500);
  });
  await capturar('/alertas', 'alertas');

  await ctx.close();
}

await browser.close();
if (erros.length) {
  console.error(`\n${erros.length} erro(s) de console/página:`);
  for (const e of erros) console.error(`  ${e}`);
  process.exit(1);
}
console.log('console limpo');
