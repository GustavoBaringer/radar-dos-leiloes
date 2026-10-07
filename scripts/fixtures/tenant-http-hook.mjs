import { registerHooks } from 'node:module';

const connectorFiles = new Set(['vlance.ts', 'leiloar.ts', 'sishp.ts']);
const mockedHttpModule = `
export async function fetchText(url, opts = {}) {
  const fixture = globalThis.__tenantObserverHttpFixture;
  if (typeof fixture !== 'function') throw new Error('tenant HTTP fixture is not installed');
  return fixture(url, opts, 'text');
}
export async function fetchJson(url, opts = {}) {
  const response = await fetchText(url, opts);
  let data;
  try { data = JSON.parse(response.body); } catch { data = null; }
  return { status: response.status, data, raw: response.body };
}
`;
const mockUrl = `data:text/javascript,${encodeURIComponent(mockedHttpModule)}`;

export function installTenantHttpHook() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './http.js' && connectorFiles.has(new URL(context.parentURL).pathname.split('/').at(-1))) {
        return { url: mockUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

export function setTenantHttpFixture(fixture) {
  globalThis.__tenantObserverHttpFixture = fixture;
}
