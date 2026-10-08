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
