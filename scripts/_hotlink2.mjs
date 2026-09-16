import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const q = (sql) => execSync(`docker exec leilao-db psql -U leilao -d leilao -t -A -F'|' -c ${JSON.stringify(sql)}`)
  .toString().trim().split('\n').filter(Boolean).map((l) => l.split('|'));

// foto REAL do kuss, não o placeholder "indisp"
const kuss = q(`SELECT photos->>0 FROM lots WHERE source_id='kuss' AND photos->>0 NOT LIKE '%indisp%' LIMIT 1`);
console.log('kuss real:', kuss[0]?.[0] ?? '(só placeholder no índice)');

const amostra = q(`SELECT DISTINCT ON (source_id) source_id, photos->>0 FROM lots WHERE photo_count>0 ORDER BY source_id, id DESC`);
if (kuss[0]?.[0]) {
  const i = amostra.findIndex((a) => a[0] === 'kuss');
  if (i >= 0) amostra[i][1] = kuss[0][0];
}

const b = await chromium.launch({ headless: true, executablePath: '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const ctx = await b.newContext();
const p = await ctx.newPage();
const falhas = [];
p.on('requestfailed', (r) => falhas.push(`${new URL(r.url()).host}: ${r.failure()?.errorText}`));
await p.route('https://radar-teste.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>t</h1>' }));
await p.goto('https://radar-teste.example/');

console.log('\nfonte        hotlink  peso original   vs 18KB do proxy');
let somaOriginal = 0, n = 0;
for (const [fonte, url] of amostra) {
  const r = await p.evaluate(([u]) => new Promise((res) => {
    const img = new Image();
    const t = setTimeout(() => res({ ok: false }), 15000);
    img.onload = () => { clearTimeout(t); res({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(t); res({ ok: false }); };
    img.src = u;
  }), [url]);
  let peso = null;
  if (r.ok) {
    try {
      const resp = await fetch(url, { headers: { referer: 'https://radar-teste.example/' } });
      peso = Number(resp.headers.get('content-length')) || (await resp.arrayBuffer()).byteLength;
      somaOriginal += peso; n++;
    } catch { /* medido só onde a origem deixa */ }
  }
  console.log(`${fonte.padEnd(12)} ${(r.ok ? 'SIM' : 'NÃO').padEnd(8)} ${(peso ? `${Math.round(peso/1024)} KB` : '—').padEnd(15)} ${peso ? `${(peso/1024/18).toFixed(1)}x` : ''}`);
}
console.log(`\nmédia do original: ${Math.round(somaOriginal/n/1024)} KB · proxy hoje: 18 KB · fator ${(somaOriginal/n/1024/18).toFixed(1)}x`);
console.log(`página de 24 cards: ${Math.round(somaOriginal/n*24/1024/1024*10)/10} MB em hotlink vs 0,43 MB hoje`);
if (falhas.length) console.log('\nfalhas de rede:', [...new Set(falhas)].join(' | '));
await b.close();
