import assert from 'node:assert/strict';
import test from 'node:test';
import { conectorDaPlataforma, PLATAFORMAS } from '../src/domain/discovery/discovery.js';

const detecta = (html: string) => PLATAFORMAS.find(([, re]) => re.test(html))?.[0] ?? null;

test('assinatura de plataforma não casa por substring', () => {
  // Fragmentos reais capturados de HTML público em 13/10/2026.
  assert.equal(detecta('1ª V. DE AUGUSTINÓPOLIS-TO. MOTOCICLETA SUZUKI 125 YES 2008'), null);
  assert.equal(detecta('<img src="https://static.suporteleiloes.com.br/rapidaovendecombr/banners/sl-banner-3.png">'), 'suporte-leiloes');
  assert.equal(detecta('<script src="/v3/js/vlance/firebase/container-banner.js"></script>'), 'vlance');
  assert.equal(detecta('<meta name="author" content="SOLEON Soluções para Leilões Online">'), 'soleon');
  assert.equal(detecta('<meta name="Author" content="Roisoft - Softwares Web - comercial@roisoft.com.br"/>'), 'docx-html');
  assert.equal(detecta('<section class="leilao-card" data-url="/leilao/2-vara-execucao-titulos-extrajudiciais-conflitos-arbitrais/br">'), 'html-agenda');
});

test('resolves the connector from the preserved platform or detected platform', () => {
  assert.equal(conectorDaPlataforma(null, 'html-agenda'), 'htmlagenda');
  assert.equal(conectorDaPlataforma('soleon', 'html-agenda'), 'soleon');
  assert.equal(conectorDaPlataforma('html-agenda', null), 'htmlagenda');
  assert.equal(conectorDaPlataforma('vip-leiloes', 'soleon'), null);
  assert.equal(conectorDaPlataforma(null, 'unknown-platform'), null);
  assert.equal(conectorDaPlataforma(null, null), null);
  assert.equal(conectorDaPlataforma(undefined, undefined), null);
});
