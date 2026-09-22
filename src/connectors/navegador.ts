import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';

/**
 * superbid (Cloudflare) e caixa (Radware/ShieldSquare) exigem um navegador de
 * verdade. MEDIDO em 22/09: `fetchJson` cru bate no desafio quase sempre — 1
 * sucesso em 1.458 tentativas do superbid, cabeçalho `cf-mitigated: challenge`.
 * O mesmo Chromium headless que os testes E2E já usam (`acharChromium`, mesmo
 * padrão de app-busca/scripts) passa de primeira nos dois: 200 real, sem
 * interstício, tanto na página quanto na API JSON chamada de dentro dela.
 */

function acharChromium(): string | null {
  const cache = path.join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return null;
  const rev = (d: string) => Number(d.split('-').pop());
  for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => rev(b) - rev(a))) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const exe = path.join(cache, dir, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TITULO_DESAFIO = /just a moment|attention required|checking your browser/i;

/** Espera ativamente o desafio (Cloudflare "Just a moment...") resolver em JS
 * — sem isto a primeira chamada dentro de `fn` ainda bate na página de espera. */
async function esperaDesafio(page: Page) {
  for (let i = 0; i < 6; i++) {
    if (!TITULO_DESAFIO.test(await page.title())) return;
    await page.waitForTimeout(1500);
  }
}

/**
 * Abre um Chromium headless, visita `entrada` até o desafio do WAF resolver, e
 * entrega a `page` (já com os cookies de sessão) pra `fn` reusar em quantas
 * chamadas quiser. Fecha o browser sempre, sucesso ou erro — um coletor
 * agendado 3x/dia não pode deixar processo pendurado entre execuções.
 */
export async function comNavegador<T>(entrada: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const exe = acharChromium();
  if (!exe) {
    throw new Error('Chromium do Playwright não encontrado em ~/.cache/ms-playwright — rode `npx playwright install chromium`');
  }
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(entrada, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await esperaDesafio(page);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export interface RespostaNavegador {
  status: number;
  raw: string;
  /** URL onde o fetch pousou depois de seguir redirect — `fetch()` do browser
   * não expõe o Location intermediário, só o destino final. */
  url: string;
}

/** GET dentro da página já autenticada — herda os cookies que `comNavegador` resolveu. */
async function getBruto(page: Page, url: string, headers: Record<string, string>): Promise<RespostaNavegador> {
  return page.evaluate(
    async ([u, h]) => {
      const res = await fetch(u as string, { headers: h as Record<string, string> });
      return { status: res.status, raw: await res.text(), url: res.url };
    },
    [url, headers] as const,
  );
}

export async function getJsonViaNavegador<T = any>(
  page: Page,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T | null; raw: string }> {
  const { status, raw } = await getBruto(page, url, headers);
  try {
    return { status, data: JSON.parse(raw) as T, raw };
  } catch {
    return { status, data: null, raw };
  }
}

/** Decodifica como latin1 dentro da própria página — `res.text()` do browser
 * assume UTF-8 e corromperia acento em arquivo que não é (caso do CSV da Caixa). */
export async function getLatin1ViaNavegador(
  page: Page,
  url: string,
  headers: Record<string, string> = {},
): Promise<RespostaNavegador> {
  return page.evaluate(
    async ([u, h]) => {
      const res = await fetch(u as string, { headers: h as Record<string, string> });
      const buf = await res.arrayBuffer();
      return { status: res.status, raw: new TextDecoder('iso-8859-1').decode(buf), url: res.url };
    },
    [url, headers] as const,
  );
}
