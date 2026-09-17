/**
 * O vocabulário da tela, num lugar só.
 *
 * Portado de app.js e cartao.js, onde já vivia centralizado depois que o cartão
 * nasceu duplicado e as cópias divergiram em silêncio (a home ficou com o id
 * cru — "vlance", "leilaopro" — no lugar do nome da fonte).
 *
 * Todo rótulo aqui é `Record<string, string>` lido com fallback para o valor
 * cru: fonte nova entra no índice antes de entrar nesta lista, e id de
 * implementação na tela é melhor que espaço em branco.
 */
export const SRC_LABEL: Record<string, string> = {
  superbid: 'Superbid', copart: 'Copart', leilo: 'Leilo', kuss: 'Kuss', caixa: 'Caixa',
  vlance: 'vLance', soleon: 'SOLEON', freitas: 'Freitas', leilaopro: 'Leilão PRO',
  suaplataforma: 'Sua Plataforma', suporteleiloes: 'Suporte Leilões', bomvalor: 'Bom Valor',
};

export const LABEL_STATUS: Record<string, string> = {
  aberto: 'Aberto para lances', agendado: 'Agendado', encerrado: 'Encerrado',
  vendido: 'Vendido', sem_data: 'Sem data definida',
};

export const LABEL_DOC: Record<string, string> = {
  judicial: 'Judicial', extrajudicial: 'Extrajudicial',
  recuperado_financiamento: 'Recuperado de financiamento', sinistrado: 'Sinistrado',
  sucata: 'Sucata', frota: 'Frota / locadora', conservado: 'Conservado',
};

export const LABEL_VEHICLE: Record<string, string> = {
  carro: 'Carro', suv: 'SUV', picape: 'Picape', moto: 'Moto', caminhao: 'Caminhão',
  onibus: 'Ônibus', utilitario: 'Utilitário / Van', maquina: 'Máquina', reboque: 'Reboque',
  nautico: 'Náutico', peca: 'Peça', outro: 'Outro',
};

export const LABEL_PROPERTY: Record<string, string> = {
  apartamento: 'Apartamento', casa: 'Casa / sobrado', terreno: 'Terreno / lote',
  comercial: 'Comercial', rural: 'Rural', vaga: 'Vaga de garagem', outro: 'Outro',
};

export const LABEL_SELLER: Record<string, string> = {
  banco: 'Banco', seguradora: 'Seguradora', financeira: 'Financeira', locadora: 'Locadora',
  judicial: 'Judicial', orgao: 'Órgão público', particular: 'Particular', desconhecido: 'Não informado',
};

export const LABEL_ASSET: Record<string, string> = {
  veiculo: 'Veículo', imovel: 'Imóvel', outro: 'Outro (peça, lote misto)',
};

export const LABEL_CLOSING: Record<string, string> = {
  timer_por_lote: 'Timer por lote',
  pregao_em_horario: 'Pregão em horário marcado',
  sequencial: 'Encerramento sequencial',
};

export const LABEL_CANAL: Record<string, string> = {
  sino: 'na plataforma', push: 'navegador', email: 'e-mail',
};

export const LABEL_COR: Record<string, string> = {
  branco: 'Branco', preto: 'Preto', prata: 'Prata', cinza: 'Cinza', vermelho: 'Vermelho',
  azul: 'Azul', verde: 'Verde', amarelo: 'Amarelo', marrom: 'Marrom', laranja: 'Laranja',
  roxo: 'Roxo', rosa: 'Rosa',
};

export const LABEL_COMB: Record<string, string> = {
  flex: 'Flex', gasolina: 'Gasolina', alcool: 'Álcool', diesel: 'Diesel',
  gnv: 'GNV', eletrico: 'Elétrico', hibrido: 'Híbrido',
};

/**
 * Por que a fonte não publica encerramento por lote. Sem isto, o campo virava
 * travessão — e travessão não distingue "a fonte não publica" de "a coleta
 * falhou", que é a diferença que o comprador precisa para decidir.
 */
export const EXPLICA_FECHAMENTO: Record<string, string> = {
  timer_por_lote: 'Cada lote fecha na própria hora, com cronômetro.',
  pregao_em_horario: 'Pregão em horário marcado. A fonte não publica hora de fim por lote.',
  sequencial: 'Encerramento sequencial: os lotes fecham um após o outro, sem hora fixa por lote.',
};

export const ORDENACOES: Array<{ value: string; label: string }> = [
  { value: 'ending_soon', label: 'Encerra primeiro' },
  { value: 'discount', label: 'Maior diferença para a avaliação' },
  { value: 'price_asc', label: 'Menor lance' },
  { value: 'price_desc', label: 'Maior lance' },
  { value: 'recent', label: 'Adicionados recentemente' },
];

export const rotulo = (mapa: Record<string, string>, v: string | null | undefined) =>
  v == null ? null : (mapa[v] ?? v);
