/**
 * Hotlink funciona? Testa carregar a foto de cada fonte DIRETO numa página
 * hospedada noutro domínio — que é exatamente o que o navegador do usuário faria.
 * curl não serve aqui: o que barra hotlink é política de navegador (ORB/CORB,
 * mixed content) e checagem de Referer no servidor, nenhuma das duas visível
 * numa requisição de linha de comando sem contexto de página.
 */
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const fontes = execSync(
  `docker exec leilao-db psql -U leilao -d leilao -t -A -F'|' -c "SELECT DISTINCT ON (source_id) source_id, photos->>0 FROM lots WHERE photo_count > 0 ORDER BY source_id, id DESC"`,
).toString().trim().split('\n').map((l) => l.split('|'));

const b = await chromium.launch({
  headless: true,
  executablePath: '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
});
const ctx = await b.newContext({ ignoreHTTPSErrors: false });
const p = await ctx.newPage();

// Serve uma página a partir de um domínio DIFERENTE do da foto, para que o
// Referer enviado seja de terceiro — a condição real do hotlink.
await p.route('https://radar-teste.example/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>teste</h1>' }),
);
await p.goto('https://radar-teste.example/');

console.log('fonte        carrega  dimensões      erro');
for (const [fonte, url] of fontes) {
  const r = await p.evaluate(
    ([u]) =>
      new Promise((resolve) => {
        const img = new Image();
        const t = setTimeout(() => resolve({ ok: false, motivo: 'timeout 15s' }), 15000);
        img.onload = () => { clearTimeout(t); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = () => { clearTimeout(t); resolve({ ok: false, motivo: 'onerror (bloqueado, TLS ou 4xx)' }); };
        img.src = u;
      }),
    [url],
  );
  console.log(
    `${fonte.padEnd(12)} ${(r.ok ? 'SIM' : 'NÃO').padEnd(8)} ${(r.ok ? `${r.w}x${r.h}` : '—').padEnd(14)} ${r.motivo ?? ''}`,
  );
}
await b.close();
