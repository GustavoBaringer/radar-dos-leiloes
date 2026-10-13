import assert from 'node:assert/strict';
import { nomeOrigem } from '../src/lib/format.ts';

assert.equal(nomeOrigem(' Site Oficial ', 'Joyce Ribeiro', 'jrleiloes.com.br', 'https://www.jrleiloes.com.br/lote/1', 'jr'), 'Site Oficial');
assert.equal(nomeOrigem(' ', ' Joyce Ribeiro ', 'jrleiloes.com.br', 'https://www.jrleiloes.com.br/lote/1', 'jr'), 'Joyce Ribeiro');
assert.equal(nomeOrigem(null, null, 'www.jrleiloes.com.br', null, 'jr'), 'jrleiloes.com.br');
assert.equal(nomeOrigem(null, null, 'https://bad host', 'https://www.jrleiloes.com.br/lote/1', 'jr'), 'jrleiloes.com.br');
assert.equal(nomeOrigem(null, null, ' ', 'https://www.jrleiloes.com.br/lote/1', 'jr'), 'jrleiloes.com.br');
assert.equal(nomeOrigem(null, null, 'ftp://bad.example', 'ftp://bad.example', 'jr'), 'jr');
assert.equal(nomeOrigem(null, null, null, 'not a url', 'jr'), 'jr');
assert.equal(nomeOrigem(null, null, null, null, 'jr'), 'jr');
