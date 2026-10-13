import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAsset } from '../src/core/normalize.js';

test('classifica sinais inequívocos de náutico e ensiladeira', () => {
  for (const title of ['Sea-Doo GTX', 'Sea-Doo', 'Seadoo Spark', 'Jet-ski Yamaha', 'Jet ski Yamaha', 'Jetsky Yamaha']) {
    assert.deepEqual(classifyAsset(title), { assetType: 'veiculo', vehicleType: 'nautico' }, title);
  }
  assert.deepEqual(classifyAsset('Ensiladeira agrícola'), { assetType: 'veiculo', vehicleType: 'maquina' });
  assert.deepEqual(classifyAsset('Ensiladeiras', 'Máquinas'), { assetType: 'veiculo', vehicleType: 'maquina' });
  assert.deepEqual(classifyAsset('Lote', 'Ensiladeiras'), { assetType: 'veiculo', vehicleType: 'maquina' });
});

test('preserva classificações esperadas de veículos de estrada', () => {
  assert.deepEqual(classifyAsset('Toyota Hilux'), { assetType: 'veiculo', vehicleType: 'picape' });
  assert.deepEqual(classifyAsset('Toyota SW4'), { assetType: 'veiculo', vehicleType: 'suv' });
  assert.deepEqual(classifyAsset('Toyota Corolla'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('Caminhão trator'), { assetType: 'veiculo', vehicleType: 'caminhao' });
});

test('não confunde Sea/Sea-Doo de peças e acessórios com embarcações', () => {
  assert.deepEqual(classifyAsset('Seat Ibiza'), { assetType: 'veiculo', vehicleType: 'carro' });
  for (const [title, category] of [
    ['Peças para Sea-Doo', 'Embarcações'],
    ['Acessórios Sea-Doo', 'Náutico'],
    ['Sea-Doo kit de reparo', null],
  ] as const) {
    assert.notEqual(classifyAsset(title, category).assetType, 'veiculo', title);
  }
});

test('categorias específicas existentes continuam prevalecendo', () => {
  assert.deepEqual(classifyAsset('Hilux', 'Motoniveladoras'), { assetType: 'veiculo', vehicleType: 'maquina' });
  assert.deepEqual(classifyAsset('RODANTE DE FERRO DE ESCAVADEIRA', 'Peças de Máquinas Pesadas'), {
    assetType: 'outro', vehicleType: 'peca',
  });
});

test('reconhece modelos específicos das motos reportadas sem usar a marca isolada', () => {
  const casosMoto = [
    'Yamaha MT 09 ABS',
    'YAMAHA/MT03 ABS',
    'Honda NRX 160',
    'Honda/Elite 125',
    'Yamaha TTR 230',
    'Yamaha NEO 125',
    'Yamaha XT 600 E',
    'Yamaha NEO AT115',
    'Suzuki GSR150I',
    'Kawasaki Vulcan S',
    'Kenton GL150',
    'Kenton Blitz110',
    'Kenton Dakar',
    'Leopard HB110',
    'Taiga TL150',
    'Taiga TL125',
    'Taiga 110',
    'Motostar STAR200',
    'DAX/110',
  ];
  for (const title of casosMoto) {
    assert.deepEqual(classifyAsset(title), { assetType: 'veiculo', vehicleType: 'moto' }, title);
  }
});

test('sinais de moto não prevalecem sobre embarcação, motor avulso ou automóveis', () => {
  assert.deepEqual(classifyAsset('Yamaha Jet-ski'), { assetType: 'veiculo', vehicleType: 'nautico' });
  assert.deepEqual(classifyAsset('Motor avulso Yamaha MT 09'), { assetType: 'outro', vehicleType: 'peca' });
  assert.deepEqual(classifyAsset('Honda Civic'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('Suzuki Swift', 'Automóveis'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('Peças Kawasaki Vulcan S'), { assetType: 'outro', vehicleType: 'peca' });
  assert.deepEqual(classifyAsset('Kawasaki Vulcan S peças'), { assetType: 'outro', vehicleType: 'peca' });
});

test('reconhece Volvo VM/FH/FM com código sem confundir SUVs XC', () => {
  for (const title of ['Volvo/VM 270 6x4R', 'Volvo FH 440', 'VOLVO/FM 370']) {
    assert.deepEqual(classifyAsset(title), { assetType: 'veiculo', vehicleType: 'caminhao' }, title);
  }
  assert.deepEqual(classifyAsset('Volvo XC60'), { assetType: 'veiculo', vehicleType: 'suv' });
});

/**
 * Regressões medidas na auditoria de 13/10 sobre os 19.264 veículos do índice.
 * Cada linha aqui é um lote real que estava na categoria errada.
 */
test('"MB" seguido de ano é sigla do anúncio, não código de caminhão', () => {
  // O `mb ?\d{4}` tratava o ano como modelo: três carros dentro do filtro de
  // pesado (Gol, Voyage, UP) e nenhum erro em log.
  for (const title of [
    'VW/GOL CITY MB | 2014/2015 | BRANCA', 'VW VOYAGE CL MB 2015/2015 BRANCA',
    'VW/UP MOVE MB | 2016/2017 | PRETA', 'VW GOL ROCK IN RIO MB 2015/2016 BRANCA',
  ]) {
    assert.deepEqual(classifyAsset(title), { assetType: 'veiculo', vehicleType: 'carro' }, title);
  }
  // O código de chassi continua valendo com a marca, com o tipo no título ou
  // com o sufixo/eixo que só pesado tem.
  assert.deepEqual(classifyAsset('Mercedes MB2726 2011'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('CAMINHÃO CAÇAMBA MB 1113, ANO 1973'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('MB 1634 LS 2-EIXOS'), { assetType: 'veiculo', vehicleType: 'caminhao' });
});

test('marca que só existe em caminhão vence a categoria da fonte', () => {
  // Copart guarda o HR em "Utilitários Grandes" e a Superbid em "Hatches": o
  // caminhão ia parar no filtro de van/carro por causa do rótulo da fonte.
  assert.deepEqual(classifyAsset('2011 HYUNDAI HR', 'Utilitários Grandes'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('HYUNDAI/HR HDB 2011/', 'Hatches'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('I/HYUNDAI HR HDLWBSC – 07/07 – Água Clara/MS'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO/NL12 360 4X2 - 94/95 - Branco'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('STRALISHD 490S38TN'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('12140 H - VOLKSWAGEN'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  // O SUV da mesma marca continua SUV: a regra é o modelo, não o fabricante.
  assert.deepEqual(classifyAsset('Volvo XC60', 'SUV'), { assetType: 'veiculo', vehicleType: 'suv' });
});

test('reboque no título não é caminhão, mesmo com a categoria dizendo o contrário', () => {
  // Copart põe semirreboque em "Caminhões e Rebocadores" e o leilo em
  // "Pesados": 35 lotes entravam no filtro de caminhão sem serem caminhão.
  assert.deepEqual(classifyAsset('2022 ESTRADA SEMI-REBOQUE', 'Caminhões e Rebocadores'), { assetType: 'veiculo', vehicleType: 'reboque' });
  assert.deepEqual(classifyAsset('2020 LIBRELATO SEMI-REBOQUE'), { assetType: 'veiculo', vehicleType: 'reboque' });
  assert.deepEqual(classifyAsset('RANDON/SR BA', 'Pesados'), { assetType: 'veiculo', vehicleType: 'reboque' });
  assert.deepEqual(classifyAsset('ALFASTEEL/SRASBS 2EIXO', 'Pesados'), { assetType: 'veiculo', vehicleType: 'reboque' });
  assert.deepEqual(classifyAsset('SUCATA DE REBOQUE CANAVIEIRO RODOFORT RR CN, 2007/2008', 'Sucata de Carrocerias & Impl. Rodov.'), { assetType: 'veiculo', vehicleType: 'reboque' });
  // Sidecar é moto, e o código RENAVAM sozinho é ruído: duas letras + palavra
  // não são reboque. ("Transbordo ... com engate para reboque traseiro" é caixa
  // de transbordo e o dicionário já responde reboque antes e depois disto —
  // está fora do que estas regras mudam.)
  assert.deepEqual(classifyAsset('MOTONETA – BP/ LAMBRETTA (COM REBOQUE)'), { assetType: 'veiculo', vehicleType: 'moto' });
  // Código RENAVAM sozinho é ruído: dois códigos e uma palavra não são reboque.
  assert.deepEqual(classifyAsset('VW/NOVA SAVEIRO RB MBVS - 18/19'), { assetType: 'veiculo', vehicleType: 'picape' });
  assert.notEqual(classifyAsset('RE/ROYAL HUNTER 350, 26/27').vehicleType, 'reboque');
  assert.deepEqual(classifyAsset('TOYOTA/YARIS SA PLUS CONNECT'), { assetType: 'veiculo', vehicleType: 'carro' });
});
