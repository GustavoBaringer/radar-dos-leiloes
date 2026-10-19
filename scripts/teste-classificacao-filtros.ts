import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAsset, parseTitle } from '../src/core/normalize.js';

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

test('classifica caminhões, ônibus e utilitários da Mercedes-Benz reportados em produção', () => {
  // Ônibus escolares e rodoviários
  assert.deepEqual(classifyAsset('MERCEDES-BENZ/OF 1519 R.ORE'), { assetType: 'veiculo', vehicleType: 'onibus' });
  assert.deepEqual(classifyAsset('MERCEDES BENZ OF 1318, ANO/MOD: 1994/1994, COMBUSTÍVEL; DIESEL, COR: BRANCO'), { assetType: 'veiculo', vehicleType: 'onibus' });
  assert.deepEqual(classifyAsset('MERCEDES BENZ OF 1620, ANO/MOD: 1995/1995'), { assetType: 'veiculo', vehicleType: 'onibus' });
  assert.deepEqual(classifyAsset('Um automóvel, IMP/M.BENZ OF 1620, ano de fabricação/modelo 1994/1995'), { assetType: 'veiculo', vehicleType: 'onibus' });
  assert.deepEqual(classifyAsset('Mercedes-Benz Masc Granmini O 2009'), { assetType: 'veiculo', vehicleType: 'onibus' });

  // Caminhões (pesados, semi-pesados, linha L, LS, LK, LA, Atron, Accelo)
  assert.deepEqual(classifyAsset('M. BENZ / LS 1935'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('Mercedes-Benz LS 1935 1994'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M.BENZ LS 1938 - 03/03 - Brumado/BA'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('Mercedes-Benz LS 1938 2003'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M.Benz LS 1634 ano/mod. 2007/2008'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M. Benz LS'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('LK 1113 - MERCEDES BENZ'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('L 1620 - MERCEDES BENZ'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('- M.BENZ - LA 1113'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('MERCEDES-BENZ - LK-2217'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('- M.BENZ/L 312'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('MERCEDES-BENZ - ACELLO 815'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M.BENZ/915C - 10/10 - Tupã/SP'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('Mercedes Benz 710 - 97/97'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M.BENZ 1418 - 91/92'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M.BENZ/ ATRON 1719'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M.BENZ/ATRON 1719 K'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('M/BENZ Z 1620 2008'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('MBENZ 1111 MB, ANO/MODELO 1967, COR AZUL.'), { assetType: 'veiculo', vehicleType: 'caminhao' });

  // Utilitários e Vans (Sprinter, MB 180D)
  assert.deepEqual(classifyAsset('MERCEDES-BENZ 315 CDI STREET C 2024 / 2025'), { assetType: 'veiculo', vehicleType: 'utilitario' });
  assert.deepEqual(classifyAsset('I/M.BENZ 313SPRI JAEDI A Ano/modelo: 2011/2012'), { assetType: 'veiculo', vehicleType: 'utilitario' });
  assert.deepEqual(classifyAsset('- M. BENZ/ 310D SPRINTERM'), { assetType: 'veiculo', vehicleType: 'utilitario' });
  assert.deepEqual(classifyAsset('Mercedes-Benz 415CDI Sprinterm 2015/2016'), { assetType: 'veiculo', vehicleType: 'utilitario' });
  assert.deepEqual(classifyAsset('Imp/Mercedes Benz MB 180D - 95/96'), { assetType: 'veiculo', vehicleType: 'utilitario' });

  // Peças de pneus não entram como veículo
  assert.deepEqual(classifyAsset('BENS MED. - MATERIAL PNEUS - 2 PNEUS 245./45./20 PERFIL BAIXO'), { assetType: 'outro', vehicleType: 'peca' });
});

test('não confunde sigla de motor/versão MB da Volkswagen com marca Mercedes-Benz', () => {
  const polo = parseTitle('POLO MB');
  assert.equal(polo.brand, 'VOLKSWAGEN');
  assert.equal(polo.model, 'POLO');

  const fox = parseTitle('FOX ROCK RIO MB');
  assert.equal(fox.brand, 'VOLKSWAGEN');
  assert.equal(fox.model, 'FOX');

  const voyage = parseTitle('VOYAGE CITY MB');
  assert.equal(voyage.brand, 'VOLKSWAGEN');
  assert.equal(voyage.model, 'VOYAGE');

  const gol = parseTitle('VWGOL 1.6L MB');
  assert.equal(gol.brand, 'VOLKSWAGEN');
  assert.equal(gol.model, 'GOL');

  const c4 = parseTitle('C4 PALLAS 20 GLA');
  assert.equal(c4.brand, 'CITROEN');
  assert.equal(c4.model, 'C4');
});

test('mantém carros de passeio da Mercedes-Benz como carro', () => {
  assert.deepEqual(classifyAsset('2018 MERCEDES BENZ CLASSE C'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('Direitos sobre Carro Mercedes Benz A200 AMG LINE - 2023'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('M.BENZ A 160 2003'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('M.BENZ A 190 2002'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('M.BENZ/A 160 ANO 2005 MODELO 2006'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('Mercedes-Benz SLK 200K - 2008'), { assetType: 'veiculo', vehicleType: 'carro' });
});

test('classifica caminhões, ônibus, carros e SUVs da Volvo reportados em produção', () => {
  // Caminhões do print de produção (inclusive quando vêm de categorias genéricas/erradas como 'Hatches' ou 'Carros')
  assert.deepEqual(classifyAsset('Volvo VM 260 6X2R 2008', 'Hatches'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('Volvo VM 260 6X2R 2008', 'Carros'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('Volvo VM 260 6X2R 2008'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('Volvo VM 270 6X2R 2014', 'Hatches'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('Volvo VM 270 6X2R 2014'), { assetType: 'veiculo', vehicleType: 'caminhao' });

  // Outros caminhões Volvo da linha pesada/semipesada
  assert.deepEqual(classifyAsset('VOLVO/NH12380 4X2T, 99/00, PLACA: J__-___0, DIESEL, AZUL'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO FH 460 6X2T'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO FH 540 6X4'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO VM 330 8X4R'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO FM 370'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO FMX 460'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO NL10'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO NL 12'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO N10'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO N12'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO EDC 360'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('VOLVO FH GLOBETROTTER'), { assetType: 'veiculo', vehicleType: 'caminhao' });
  assert.deepEqual(classifyAsset('CAMINHÃO TRATOR VOLVO/FH 460 6X2T'), { assetType: 'veiculo', vehicleType: 'caminhao' });

  // Ônibus com chassi Volvo e/ou encarroçadora Irizar
  assert.deepEqual(classifyAsset('Ônibus Volvo Irizar 16 PB R, ano/modelo 2013/2014'), { assetType: 'veiculo', vehicleType: 'onibus' });
  assert.deepEqual(classifyAsset('Volvo/B58 4x2 - 1995/1995 - Placa FINAL: 2H08'), { assetType: 'veiculo', vehicleType: 'onibus' });
  assert.deepEqual(classifyAsset('ÔNIBUS RODOVIÁRIO VOLVO IRIZAR CENTURY, 2012 / 2012, Placa FINAL 3 (SP)'), { assetType: 'veiculo', vehicleType: 'onibus' });
  assert.deepEqual(classifyAsset('ÔNIBUS VOLVO B10 - ANO 1995'), { assetType: 'veiculo', vehicleType: 'onibus' });

  // Carros de passeio da Volvo permanecem como carro
  assert.deepEqual(classifyAsset('Volvo C30 (2P) 2009/2010'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('Volvo V60 2.0 T5 RD DY 2014'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('Volvo S60 2.0 T5 R-Des 2014/2015'), { assetType: 'veiculo', vehicleType: 'carro' });
  assert.deepEqual(classifyAsset('VOLVO/V40 T4 COMFORTLI (4P)'), { assetType: 'veiculo', vehicleType: 'carro' });

  // SUVs da Volvo permanecem como SUV
  assert.deepEqual(classifyAsset('Volvo XC60 2.0 T5'), { assetType: 'veiculo', vehicleType: 'suv' });
  assert.deepEqual(classifyAsset('Volvo XC40'), { assetType: 'veiculo', vehicleType: 'suv' });
  assert.deepEqual(classifyAsset('Volvo XC90'), { assetType: 'veiculo', vehicleType: 'suv' });
  assert.deepEqual(classifyAsset('Volvo C40'), { assetType: 'veiculo', vehicleType: 'suv' });
  assert.deepEqual(classifyAsset('Volvo EX30'), { assetType: 'veiculo', vehicleType: 'suv' });

  // Peças de caminhão não entram como veículo
  assert.deepEqual(classifyAsset('GERAL - 60 (SESSENTA) JOGOS DE LONA DE FREIO DIANTEIRO VOLVO DA MARCA THERMOIDE'), { assetType: 'outro', vehicleType: 'peca' });
});

test('classifica máquinas agrícolas e ferramentas/acoplagens sem afetar caminhões rodoviários', () => {
  // Máquinas agrícolas e implementos
  assert.deepEqual(
    classifyAsset('COLHEITADERIA - MASSEY FERGUSON/MF 9695 TRIDENT'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
  assert.deepEqual(
    classifyAsset('NEW HOLLAND/PLATAFORMA 7220'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
  assert.deepEqual(
    classifyAsset('PLATAFORMA 11LX50', 'Pesados'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
  assert.deepEqual(
    classifyAsset('GRADE ARADORA CRI DE 16C/DSC REC 28', 'Pesados'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
  assert.deepEqual(
    classifyAsset('GRADE ARADORA PESADA / ANTONIASI /GRADE PESADA ATA 24GPATA', 'Pesados'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
  assert.deepEqual(
    classifyAsset('TRATO AGRICOLA, MODELO MF 6711, MARCA MASSEY FERGUSON ANO 20', 'Pesados'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );

  // Contra-testes com caminhões reais
  assert.deepEqual(
    classifyAsset('CAMINHÃO TRATOR MERCEDES-BENZ LS 1932 1985 ID: #36', 'Cavalos Mecânicos'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('CAMINHÃO MERCEDES-BENZ L-2213 1973 COM PLATAFORMA GUINDAUTO', 'Caminhões Guindauto'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('SUCATA DE CAMINHÃO PLATAFORMA MERCEDES-BENZ L 2013', 'Sucata de Caminhões'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('VOLKSWAGEN CONSTELLATION 13 180 ANO 2011 COM BAU E PLATAFORMA', 'Caminhões Baú'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('CAMINHÃO TRATOR SCANIA P114 ID: #3701175', 'Cavalos Mecânicos'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('CAMINHÃO TRATOR VOLVO FH12 380 6X2 ANO 1998/1998', 'Cavalos Mecânicos'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('C. TRATOR SCANIA P114', 'Pesados'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('M.BENZ / LS 1935 / TRA / C. TRATOR', null),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('CAM. TRATOR VOLVO FH 460', 'Pesados'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('Tratores agrícolas Massey Ferguson', 'Pesados'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
});

test('classifica modelos clássicos Mercedes, ônibus Induscar, vans e eixos', () => {
  // Caminhões clássicos e anos antigos. "M.BENZ 1963 1963 AZUL" NÃO entra aqui:
  // ano de modelo não é código de caminhão, e o lote está em "Hatches" no
  // índice. Era a regra "marca + ano" que o transformava em caminhão (16/10).
  assert.deepEqual(
    classifyAsset('M.BENZ  1963 1963 AZUL', 'Hatches'),
    { assetType: 'veiculo', vehicleType: 'carro' },
  );
  assert.deepEqual(
    classifyAsset('Mercedes-Benz 1111 MB 1967', 'Sucata de Carros'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('MERCEDES BENZ/LP 321 – 59/59'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('MERCEDES BENZ/LAP 321 – 65/65'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('MERCEDES 608  1982/1982', 'Bomvalor Corporativo'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('MERCEDES 1519 6 X 6  1976/1976', 'Bomvalor Corporativo'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );

  // Utilitários / Vans Mercedes
  assert.deepEqual(
    classifyAsset('MERCEDES BENS FURGÃO MODELO: 415DISPRINTERF', 'Carros'),
    { assetType: 'veiculo', vehicleType: 'utilitario' },
  );
  assert.deepEqual(
    classifyAsset('M.BENZ MARIMAR - PLACA: O**-**19', 'Carros'),
    { assetType: 'veiculo', vehicleType: 'utilitario' },
  );
  assert.deepEqual(
    classifyAsset('I/M.BENZ VITO111CDI'),
    { assetType: 'veiculo', vehicleType: 'utilitario' },
  );

  // Ônibus Induscar
  assert.deepEqual(
    classifyAsset('MERCEDES BENZ/INDUSCAR APACHE U'),
    { assetType: 'veiculo', vehicleType: 'onibus' },
  );
  assert.deepEqual(
    classifyAsset('M.BENZ/INDUSCAR MILLEN U'),
    { assetType: 'veiculo', vehicleType: 'onibus' },
  );

  // Peças / Eixos
  assert.deepEqual(
    classifyAsset('Eixo Mercedes', 'Telehandlers'),
    { assetType: 'outro', vehicleType: 'peca' },
  );

  // Contra-testes com carros legítimos Mercedes
  assert.deepEqual(
    classifyAsset('M.BENZ A 160 2005 2005 PRATA', 'Hatches'),
    { assetType: 'veiculo', vehicleType: 'carro' },
  );
  assert.deepEqual(
    classifyAsset('2018 MERCEDES BENZ CLASSE C', 'Automóveis'),
    { assetType: 'veiculo', vehicleType: 'carro' },
  );
  assert.deepEqual(
    classifyAsset('AUTOMOVEL - IMP MERCEDES BENZ 190 E 2.6'),
    { assetType: 'veiculo', vehicleType: 'carro' },
  );
  // O ano de modelo colado na marca não pode virar código de caminhão: em
  // 16/10 o "2013" estava na lista e estas três viravam `caminhao` — a van e o
  // sedan perdiam o filtro de leve e o caminhão entrava com ano de carro.
  assert.deepEqual(
    classifyAsset('2013 MERCEDES BENZ SPRINTER', 'Utilitários Grandes'),
    { assetType: 'veiculo', vehicleType: 'utilitario' },
  );
  assert.deepEqual(
    classifyAsset('MERCEDES-BENZ C-180 TURBO 2013/2014 GASOLINA', null),
    { assetType: 'veiculo', vehicleType: 'carro' },
  );
});

test('motobomba é equipamento, não motocicleta', () => {
  assert.deepEqual(
    classifyAsset('Conjunto de Irrigação Motor Mercedes Benz com Moto Bomba', 'Bombas'),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
  assert.deepEqual(
    classifyAsset('SCHNEIDER - MOTOBOMBA CENTRIFUGA SUBMERSIVEL', null),
    { assetType: 'veiculo', vehicleType: 'maquina' },
  );
  // A palavra "moto" sozinha continua sendo motocicleta.
  assert.deepEqual(
    classifyAsset('MOTO HONDA CG 125 FAN 2011', 'Motos'),
    { assetType: 'veiculo', vehicleType: 'moto' },
  );
});

test('título que declara o bem vence categoria de equipamento', () => {
  // O Superbid e o grupolance guardam veículo em "Eletrônico": eles sumiam do
  // índice inteiro (23 lotes medidos em 16/10).
  assert.deepEqual(
    classifyAsset('Caminhão Mercedes Benz/L 1620, ano/modelo 2010', 'Eletrônico'),
    { assetType: 'veiculo', vehicleType: 'caminhao' },
  );
  assert.deepEqual(
    classifyAsset('Motocicleta Honda/CG 125 Titan KS', 'Eletrônico'),
    { assetType: 'veiculo', vehicleType: 'moto' },
  );
  // Equipamento que não é veículo continua fora do índice de veículos.
  assert.deepEqual(
    classifyAsset('CAIXA DE SOM PULSE', 'Equipamentos'),
    { assetType: 'outro', vehicleType: null },
  );
});



