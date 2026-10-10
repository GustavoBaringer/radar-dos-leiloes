import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarLanceMinimoKuss } from '../src/connectors/kuss.js';

test('Kuss consulta o lance inicial pelo id estável, com loteado=S', async () => {
  const bid = await buscarLanceMinimoKuss('897', '279976', async (url, opts) => {
    assert.equal(url, 'https://www.claudiokussleiloes.com.br/json_lance_historico.php');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.gapMs, 900);
    const params = new URLSearchParams(opts.body);
    assert.equal(params.get('leilaoID'), '897');
    assert.equal(params.get('le_id'), '279976');
    assert.equal(params.get('loteado'), 'S');
    assert.equal(params.get('seq'), '0');
    return { status: 200, data: { av: '15.200,00', of: ['17000'], incr: '500,00' } };
  });
  assert.equal(bid, 15200);
});

test('Kuss não confunde ofertas e incremento com lance mínimo ausente', async () => {
  assert.equal(await buscarLanceMinimoKuss('897', '279976', async () => ({
    status: 200, data: { of: ['17000'], incr: '500,00' },
  } as any)), null);
});

test('Kuss aceita valor numérico e ignora valores vazios ou inválidos', async () => {
  for (const [av, expected] of [[15200.5, 15200.5], ['1.500,50', 1500.5], ['', null], [0, null], [-1, null], ['abc', null], [null, null]] as const) {
    assert.equal(await buscarLanceMinimoKuss('897', '279976', async () => ({ status: 200, data: { av } })), expected);
  }
});

test('Kuss falha na consulta incompleta em vez de mapear NULL silenciosamente', async () => {
  for (const result of [{ status: 503, data: {} }, { status: 200, data: null }, { status: 200, data: [] }]) {
    await assert.rejects(buscarLanceMinimoKuss('897', '279976', async () => result as any), /Histórico Kuss inválido/);
  }
  await assert.rejects(buscarLanceMinimoKuss('897', '279976', async () => { throw new Error('timeout'); }), /timeout/);
  await assert.rejects(buscarLanceMinimoKuss('897', '../1'), /Identidade Kuss inválida/);
});
