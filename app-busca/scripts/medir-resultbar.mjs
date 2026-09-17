/** Mede a barra de resultados COM e SEM "interpretado como" — é a presença
    dos chips que estoura a linha e esmaga o seletor de ordenação. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const API = 'http://localhost:4500';
function ach(){const c=path.join(homedir(),'.cache','ms-playwright');const r=d=>Number(d.split('-').pop());
for(const d of readdirSync(c).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>r(b)-r(a)))
for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const e=path.join(c,d,rel);if(existsSync(e))return e}return null}
const b = await chromium.launch({ executablePath: ach() });
const casos = [
  { nome: 'sem interpretação', rota: '/busca?assetType=veiculo' },
  { nome: 'COM interpretação', rota: '/busca?q=cruze' },
];
for (const w of [390, 1440]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${API}/login`, { waitUntil: 'load' });
  await p.fill('#usuario', process.env.APP_USUARIO);
  await p.fill('#senha', process.env.APP_SENHA);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  for (const c of casos) {
    await p.goto(`${API}${c.rota}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1600);
    const m = await p.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null;
        const b = e.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) }; };
      return { barra: r('.resultbar'), conta: r('.resultbar > div'), sel: r('.ordena select'), alerta: r('.btn-alerta'), interp: r('.interpreted') };
    });
    console.log(`${w}px · ${c.nome.padEnd(18)} barra h=${String(m.barra.h).padStart(3)} | select w=${String(m.sel.w).padStart(3)} | alerta w=${String(m.alerta.w).padStart(3)} | chips=${m.interp ? 'sim' : 'não'}`);
    if (m.sel.w < 90) console.log(`      ^ SELECT ESMAGADO (${m.sel.w}px é só a seta)`);
  }
  await ctx.close();
}
await b.close();
