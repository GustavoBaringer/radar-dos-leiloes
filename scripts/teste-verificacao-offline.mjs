import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const fixedNow = Date.parse('2026-10-15T12:00:00Z');
const originalNow = Date.now;
Date.now = () => fixedNow;
const lotes = [{ id: 1, externalId: null, lotUrl: 'https://fixture.invalid/lote/1', categoria: null }];
const requests = [];
const fakeHttp = {
  async fetchText(url) {
    requests.push(url);
    return { status: 200, body: url.includes('soleon') ? '<div id="status_lote"><div class="label_lote aberto_lance">Status</div>' : '<div id="status_lote"><div class="label_lote sem_licitante">Sem licitante</div><strong>Data 2º Leilão:</strong> 16/10/2026 12:00' };
  },
  async fetchJson(url) {
    requests.push(url);
    return { status: 200, data: { items: [{ lote_id: 1, nm_statuslote: 'ativo' }, null] } };
  },
};
function loadTs(source, filename, allowed) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)((id) => {
    if (!(id in allowed)) throw new Error(`require não permitido: ${id} (${filename})`);
    return allowed[id];
  }, module, module.exports);
  return module.exports;
}
try {
  const domain = loadTs(readFileSync('src/domain/lots/verification.ts', 'utf8'), 'domain', {});
  const current = loadTs(readFileSync('src/infra/verification/verifiers.ts', 'utf8'), 'current', {
    '../../connectors/http.js': fakeHttp, '../../domain/lots/verification.js': domain,
  }).VERIFICADORES;
  const baselineSource = execFileSync('git', ['show', '6a9bdf3:src/core/verificacao.ts'], { encoding: 'utf8' });
  const baseline = loadTs(baselineSource, 'baseline', { '../connectors/http.js': fakeHttp }).VERIFICADORES;
  for (const [name, html, expected] of [
    ['soleon', '<div id="status_lote"><div class="label_lote aberto_lance">Status</div>', 'aberto'],
    ['soleon', '<div id="status_lote"><div class="label_lote sem_licitante">Sem licitante</div><strong>Data 2º Leilão:</strong> 16/10/2026 12:00', 'agendado'],
  ]) {
    fakeHttp.fetchText = async () => ({ status: 200, body: html });
    const before = [...await baseline[name].verificar('soleon.invalid', lotes)];
    const after = [...await current[name].verificar('soleon.invalid', lotes)];
    assert.deepEqual(after, before);
    assert.equal(after[0][1].veredito, expected);
  }
  fakeHttp.fetchJson = async (url) => url.includes('tipo=1')
    ? { status: 200, data: { items: [{ lote_id: 1, nm_statuslote: 'ativo' }, null] } }
    : { status: 200, data: { items: [] } };
  for (const impl of [baseline, current]) {
    const result = await impl.vlance.verificar('vlance.invalid', lotes);
    assert.equal(result.get(1).veredito, 'aberto');
  }
  console.log('PASS: 2 Soleon fixtures diferencialmente iguais; VLance item null isolado por tipo sem throw; require whitelist sem rede.');
} finally { Date.now = originalNow; }
