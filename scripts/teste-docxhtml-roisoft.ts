import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ROISOFT_HOSTS, tipo } from '../src/connectors/docxhtml.js';

// Respostas reais de GET /lotes/listar-dados capturadas em 13/10/2026
// (fixtures/docxhtml/roisoft-api.json). A API ignora
// porPagina=40 e devolve 20 por página; é isso que truncava o catálogo.
interface CapturaApi {
  out: Array<{
    domain: string; papel: string; status: number | null; erro: string | null; forma: string | null;
    totalItens: number | null;
    paginacao: { pageCount: number; itemCountPerPage: number; totalItemCount: number } | null;
    amostra: Record<string, unknown> | null;
  }>;
}
const captura = JSON.parse(
  readFileSync('fixtures/docxhtml/roisoft-api.json', 'utf8'),
) as CapturaApi;
const porDomain = new Map(captura.out.map(r => [r.domain, r]));
// Estrito de propósito: `paginacao` e `amostra` podem faltar no JSON e o teste
// precisa acusar em vez de ler `undefined` em silêncio.
const paginacaoDe = (domain: string) => {
  const p = porDomain.get(domain)?.paginacao;
  assert.ok(p, `${domain} sem dadosPaginacao`);
  return p;
};
const amostraDe = (domain: string) => {
  const a = porDomain.get(domain)?.amostra;
  assert.ok(a, `${domain} sem amostra`);
  return a as Record<string, string>;
};

test('tenants Roisoft são exatamente os de contrato medido', () => {
  assert.deepEqual([...ROISOFT_HOSTS].sort(), [
    'caiapoleiloes.com.br', 'leiloeiroeduardo.com.br', 'leiloesbrasil.com.br', 'sancarleiloes.com.br',
  ]);
});

test('a API entrega a mesma forma em todos os 4 tenants', () => {
  for (const domain of ROISOFT_HOSTS) {
    const r = porDomain.get(domain)!;
    assert.equal(r.status, 200, `${domain} respondeu ${r.status}`);
    assert.equal(r.forma, 'json', `${domain} não devolveu JSON`);
    // A API aceita porPagina=40 mas entrega 20: contrato medido, não suposição.
    assert.equal(paginacaoDe(domain).itemCountPerPage, 20, `${domain} não entregou a página de 20`);
    assert.ok((r.totalItens ?? 0) <= 20, `${domain} devolveu mais que uma página sem pedir a próxima`);
  }
});

test('paginação precisa ser percorrida: um só GET não cobre o catálogo', () => {
  // Regressão do truncamento: ler só pagina=1 entregaria 20 de 102 no Leilões
  // Brasil. O loop tem de consumir pageCount páginas.
  for (const domain of ['caiapoleiloes.com.br', 'leiloesbrasil.com.br']) {
    const paginacao = paginacaoDe(domain);
    const primeiraPagina = paginacao.itemCountPerPage;
    const total = paginacao.totalItemCount;
    assert.ok(paginacao.pageCount > 1, `${domain} tem ${total} itens em mais de uma página`);
    assert.equal(paginacao.pageCount, Math.ceil(total / primeiraPagina), `${domain}: pageCount inconsistente`);
  }
});

test('tenant vazio responde 200 com catálogo zerado, não com erro', () => {
  // SanCar e Eduardo têm a mesma API e 0 itens. Isso é "sem lote agora", e a
  // nota de parcial precisa dizer isso em vez de a coleta parecer quebrada.
  for (const domain of ['sancarleiloes.com.br', 'leiloeiroeduardo.com.br']) {
    const r = porDomain.get(domain)!;
    assert.equal(r.status, 200);
    assert.equal(r.totalItens, 0);
    assert.equal(paginacaoDe(domain).totalItemCount, 0);
    assert.equal(paginacaoDe(domain).pageCount, 0);
  }
});

test('a amostra do Leilões Brasil é imóvel e a do Caiapó é equipamento', () => {
  const lb = amostraDe('leiloesbrasil.com.br');
  assert.equal(lb.situacao, 'NAO_ARREMATADO');
  assert.equal(lb.siteSituacao, 'REALIZADO');
  assert.match(lb.titulo, /APARTAMENTO/);
  const c = amostraDe('caiapoleiloes.com.br');
  assert.equal(c.situacao, 'LIBERADO_LEILAO');
  assert.equal(c.siteSituacao, 'EM_LOTEAMENTO');
  assert.equal(c.fim, 'HOJE, 13/OUT/2026 - 14h00');
});

// Títulos reais dos 102 do Leilões Brasil (13/10/2026). A API não manda
// categoria, então o classificador global cairia no padrão `veiculo/carro`:
// sem esta evidência no título, 62 de 102 lotes legítimos sumiam (bug antigo) e
// as mesas/cadeiras e sucata entrariam como carro (delegar ao global seria o
// erro oposto).
test('tipo só aceita veículo nomeado no título', () => {
  for (const t of [
    'MARCOPOLO - ONIBUS MARCOPOLO/VOLARE V8L ESCOLAR 31PAS',
    'LS - TRATOR LS U80R 4CC 4X4',
    'VALTRA - TRATOR VALTRA A-950',
    'GERAL - Mini escavadeira de 1.000 kg',
    'PICCIN - GRADE NIVELADORA PICCIN',
    'NEW HOLLAND - PA CARREGADEIRA NEW HOLLAND 12B',
    'CITROEN - CITROEN/AIRCROSS M FEEL 1.6 FLEX',
    'CITROEN - I/CITROEN JUMPY FUT AMBULANCIA 1.5 DIESEL',
    'L - MMC/L200 TRITON GLX CAB.DUPLA 3.2 DIESEL',
    'RENAULT - Microonibus Renault Master Eurolaf P',
    'FIAT - FIAT/UNO MILLE SMART',
    'VW - VW/GOL 1.0 FLEX GIV',
    'FIAT - FIAT/TORO ENDURANCE ATD4 2.0 DIESEL',
    'GM - GM/S10 GREENCAR AMB M13 2.8 DIESEL',
    'TOYOTA - TOYOTA FIELDER',
    "202605000030 - GALPAO COMERCIAL - MEGA PREDIO COM/RES EM CONSTRUCAO",
  ]) assert.equal(tipo(t, null), t.startsWith('2026') ? 'imovel' : 'veiculo', t);
});

test('tipo reconhece imóvel por marcador de área e por tipo', () => {
  for (const t of [
    '19625 - CHACARA',
    '81694 - TRINDADE/GO - SOBRADO - COM AREA DE 206,46 m2',
    '116.435 - BAURU/SP - APARTAMENTO - CONFORME MATRICULA',
    '1533 - BONFIM/RR - GLEBA - COM AREA DE 92,7172 ha',
  ]) assert.equal(tipo(t, null), 'imovel', t);
});

test('tipo recusa o que o classificador global chamaria de carro', () => {
  // Estes 33 de 102 viravam `veiculo/carro` delegando ao global.
  for (const t of [
    '- Lote de Lampadas Halogenas, Fluorescentes e Luminaire',
    '- 65 UNDS. DE MESAS E CADEIRAS ESCOLARES',
    'DIVERSAS - SUCATAS DIVERSAS: ALUMINIOS',
    'DIVERSAS - SUCATAS DIVERSAS DE INFORMATICA',
    'M-4391 - GUARAI/TO - MISTO - COM AREA DE 268,32m²',
    '4533 - LOTE - COM 378 M2',
    '31229 - LOTE',
  ]) assert.equal(tipo(t, null), 'outro', t);
});

test('"fazenda" como município não vira imóvel', () => {
  // vlance: "Honda/NXR 150 - Fazenda Nova/GO" é moto. "fazenda" ficou fora de
  // propósito da lista de imóvel por isso.
  assert.equal(tipo('Honda/NXR 150 - Fazenda Nova/GO', null), 'veiculo');
  assert.equal(tipo('Fazenda Boa Vista - 120 hectares', null), 'outro');
});
