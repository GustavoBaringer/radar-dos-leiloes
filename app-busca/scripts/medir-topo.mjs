/** Mede o cabeçalho em larguras reais de celular. Número vale mais que o olho no PNG. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const API = 'http://localhost:4500';
function ach(){const c=path.join(homedir(),'.cache','ms-playwright');const r=d=>Number(d.split('-').pop());
for(const d of readdirSync(c).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>r(b)-r(a)))
for(const rel of ['chrome-linux64/chrome','chrome-linux/chrome']){const e=path.join(c,d,rel);if(existsSync(e))return e}return null}
const b = await chromium.launch({ executablePath: ach() });
for (const w of [360, 390, 412]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${API}/login`, { waitUntil: 'load' });
  await p.fill('#usuario', process.env.APP_USUARIO);
  await p.fill('#senha', process.env.APP_SENHA);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  await p.goto(`${API}/busca`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const m = await p.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null;
      const b = e.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width), vis: getComputedStyle(e).display !== 'none' }; };
    return {
      topo: r('.topo'), inner: r('.topo-inner'), logo: r('.logo'),
      logoTxt: r('.logo-txt'), busca: r('.busca-topo'), menu: r('.abre-menu'),
      wsdot: r('.ws-dot'), filtros: r('.filtros-toggle'), alerta: r('.btn-alerta'), ordena: r('.ordena'), primeiroCartao: r('.card'),
    };
  });
  console.log(`\n--- ${w}px ---`);
  console.log(`cabeçalho: ${m.topo.h}px de altura`);
  console.log(`  logo     t=${m.logo.t} h=${m.logo.h} w=${m.logo.w}`);
  console.log(`  logo-txt ${m.logoTxt ? `visível=${m.logoTxt.vis} w=${m.logoTxt.w}` : 'AUSENTE'}`);
  console.log(`  ws-dot   t=${m.wsdot.t} w=${m.wsdot.w}`);
  console.log(`  menu     t=${m.menu.t}`);
  console.log(`  busca    t=${m.busca.t} h=${m.busca.h} w=${m.busca.w}`);
  console.log(`  filtros  t=${m.filtros.t}`);
  console.log(`  contagem/ordena/alerta na mesma linha? ${m.ordena.t === m.alerta.t ? 'SIM' : `NAO (ordena=${m.ordena.t} alerta=${m.alerta.t})`}`);
  console.log(`  1º cartão começa em y=${m.primeiroCartao.t}`);
  await p.screenshot({ path: `shots/topo-${w}.png`, clip: { x: 0, y: 0, width: w, height: 260 } });
  await ctx.close();
}
await b.close();
