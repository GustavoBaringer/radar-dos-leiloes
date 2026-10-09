import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../app-busca/node_modules/playwright-core/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'app-busca/dist/client');
const { renderLote } = await import('../app-busca/dist/server/entry-server.js');
const template = await readFile(resolve(dist, 'index.html'), 'utf8');
const lot = {
  id: 993726, title_raw: 'KIA CERATO 2010', title_display: 'Kia Cerato 2010', source_id: 'leilo',
  asset_type: 'veiculo', vehicle_type: 'carro', status: 'aberto', closing_model: 'timer_por_lote',
  auction_end_utc: new Date(Date.now() + 86400000).toISOString(), current_bid: 1000,
  photos: [1, 2, 3, 4].map((i) => `https://photos.test/${i}.png`), photo_count: 4,
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5uQAAAAASUVORK5CYII=', 'base64');
const photos = process.env.GALERIA_PHOTOS_DIR
  ? await Promise.all([0,1,2,3].map(i=>readFile(resolve(process.env.GALERIA_PHOTOS_DIR, `source-${i}.jpg`))))
  : null;
let active = 0, maximum = 0, searchRequests = 0;
const counts = new Map();
let terminal = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/img') {
    const key = `${url.searchParams.get('u')}|${url.searchParams.get('w')}`;
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    active++; maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, 80));
    active--;
    res.setHeader('Cache-Control', 'no-store');
    if ((count === 1 && (key.endsWith('1.png|1200') || key.endsWith('2.png|180'))) || (terminal && key.endsWith('3.png|180'))) {
      res.statusCode = 503; res.setHeader('Retry-After', '1'); json({ error: 'overloaded' }); return;
    }
    const index = Number(new URL(url.searchParams.get('u')).pathname.slice(1).split('.')[0]) - 1;
    res.setHeader('Content-Type', photos ? 'image/jpeg' : 'image/png'); res.end(photos?.[index] ?? png); return;
  }
  if (url.pathname === '/api/me') return json({ logado:true, papel:'comum', conta:{id:1}, favoriteCount:0, unreadAlertCount:0 });
  if (url.pathname.startsWith('/api/lot/')) return json(lot);
  if (url.pathname === '/api/search') {
    searchRequests++;
    return json({ total:1, page:1, pageSize:24, items:[lot], interpreted:{brand:null,model:null,freeTerms:[]},
      facets:Object.fromEntries(['brands','models','states','cities','sources','assetTypes','vehicleTypes','propertyTypes','auctioneers','sellers','sellerTypes','statuses','docTypes'].map(k=>[k,[]])) });
  }
  if (url.pathname.startsWith('/api/')) return json({});
  if (url.pathname === '/busca' || url.pathname.startsWith('/lote/')) {
    const initial = url.pathname === '/busca' ? null : lot;
    const html = template.replace('<div id="root"></div>', `<div id="root">${initial ? renderLote(initial, false) : ''}</div>`)
      .replace('</body>', `<script>window.__LOTE__=${JSON.stringify(initial)};</script></body>`);
    res.setHeader('Content-Type', 'text/html'); res.end(html); return;
  }
  try {
    const path = resolve(dist, '.' + url.pathname);
    assert(path.startsWith(dist + '/'));
    const data = await readFile(path);
    res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'image/svg+xml');
    res.end(data);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless:true, args:['--no-sandbox'] });
const out = process.env.GALERIA_SCREENSHOTS;
if (out) await mkdir(out, { recursive:true });
try {
  for (const width of [390, 1440]) {
    counts.clear(); maximum = 0; searchRequests = 0;
    const page = await browser.newPage({ viewport:{width,height:1000} });
    page.setDefaultTimeout(10000);
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/lote/kia-cerato-2010-leilo-993726');
    console.log(`Início ${width}px`);
    await page.waitForFunction(() => document.querySelectorAll('.galeria img').length === 4 && [...document.querySelectorAll('.galeria img')].every(i => i.naturalWidth > 0));
    assert.equal(searchRequests, 0, 'link direto não monta busca por trás da galeria');
    assert(maximum <= 2, `máximo de ${maximum} imagens simultâneas`);
    assert.equal(counts.get('https://photos.test/1.png|1200'), 2, 'foto principal recupera 503');
    assert.equal(counts.get('https://photos.test/2.png|180'), 2, 'miniatura recupera 503');
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name:`Ver foto ${i+1}`, exact:true }).click();
      await page.waitForFunction((i) => { const img=document.querySelector('.foto-grande img'); return img?.naturalWidth > 0 && img.src.includes(encodeURIComponent(`https://photos.test/${i+1}.png`)); }, i);
    }
    if (out) await page.screenshot({path:resolve(out,`galeria-${width}.png`),fullPage:true});
    assert.deepEqual(errors, []);
    terminal = true; counts.clear();
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.galeria img').length === 4 && document.querySelectorAll('.galeria img')[3].naturalWidth > 0);
    assert.equal(counts.get('https://photos.test/3.png|180'), 3, 'falha permanente tem limite de três tentativas e não bloqueia a próxima foto');
    terminal = false;
    await page.goto(origin + '/busca');
    await page.locator('.card').waitFor();
    await page.locator('.card h3 a, .card h3 button, .card h3').first().click();
    await page.locator('.foto-grande img').waitFor();
    assert.equal(await page.locator('.card .lc-foto img').count(), 0, 'fotos da busca pausam com a galeria aberta');
    await page.getByRole('button', {name:'Fechar detalhe do lote',exact:true}).click();
    await page.locator('.card .lc-foto img').waitFor();
    await page.close();
    console.log(`OK ${width}px: quatro fotos, recuperação de 503, retentativas limitadas, busca pausada e retomada`);
  }
} finally { await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
