import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { idDoSlug, slugDoLote, type LoteParaSlug } from '../src/core/slug.js';
import { slugDoLote as slugDoApp, idDoSlug as idDoApp } from '../app-busca/src/lib/slug.js';

const duster = { brand: 'RENAULT', model: 'DUSTER', year_model: 2023, doc_type: 'sinistrado', source_id: 'copart', id: 548219 };
const fiorino = { brand: 'FIAT', model: 'FIORINO', year_model: 2020, doc_type: 'sinistrado', source_id: 'copart', id: 548216 };
const casos: LoteParaSlug[] = [duster, fiorino, { title_display: 'Caminhão Ágil', id: 3 }, { title_raw: 'Máquina Única', id: 4 }, { id: 5 }, { title_display: '!!!', id: 6 }, { title_display: `${'a'.repeat(69)} b`, id: 9 }];

test('gera os slugs canônicos dos dois lotes reportados', () => {
  assert.equal(slugDoLote(duster), 'renault-duster-2023-sinistrado-copart-548219');
  assert.equal(slugDoLote(fiorino), 'fiat-fiorino-2020-sinistrado-copart-548216');
  assert.notEqual(slugDoLote(duster), 'fiat-fiorino-2020-sinistrado-copart-548219');
});

test('normaliza acentos, fallbacks, caracteres vazios e truncamento', () => {
  assert.deepEqual(casos.slice(2).map(slugDoLote), ['caminhao-agil-3', 'maquina-unica-4', 'lote-5', 'lote-6', `${'a'.repeat(69)}-9`]);
});

test('extrai somente IDs positivos e seguros de slugs completos', () => {
  for (const parse of [idDoSlug, idDoApp]) {
    assert.equal(parse(slugDoLote(duster)), 548219);
    assert.equal(parse('a-1'), 1);
    assert.equal(parse('lote-9007199254740991'), Number.MAX_SAFE_INTEGER);
    for (const slug of ['', '548219', 'a-0', 'a-01', 'a--1', '-a-1', 'a-1-', 'a-1-extra', 'a-9007199254740992', 'A-1', 'a-1\n', 'á-1', 'a-+1', 'a-1.0']) {
      assert.equal(parse(slug), null, slug);
    }
  }
});

test('mantém paridade entre servidor, landing e app', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../src/web/slug.js', import.meta.url), 'utf8'), sandbox);
  const slugDaLanding = vm.runInContext('slugDoLote', sandbox) as typeof slugDoLote;
  for (const lot of casos) {
    const esperado = slugDoLote(lot);
    assert.equal(slugDaLanding(lot), esperado);
    assert.equal(slugDoApp(lot as Parameters<typeof slugDoApp>[0]), esperado);
  }
});
