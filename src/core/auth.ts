import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * Autenticação por senha única.
 *
 * Existe porque o app pode ser exposto fora da rede local, e sem isso qualquer
 * um na internet lê o banco inteiro, cria alertas e dispara coleta pela API.
 * Não é multiusuário: é um portão só, proporcional ao que a POC precisa.
 *
 * Sem APP_SENHA no ambiente, o portão fica DESLIGADO — é o modo local de sempre.
 */

const USUARIO = process.env.APP_USUARIO ?? 'admin';
const SENHA = process.env.APP_SENHA ?? '';
const USUARIO_COMUM = process.env.APP_USUARIO_COMUM ?? '';
const SENHA_COMUM = process.env.APP_SENHA_COMUM ?? '';

export type Papel = 'admin' | 'comum';
const SEGREDO = process.env.APP_SESSAO_SEGREDO ?? randomBytes(32).toString('hex');
/**
 * Duas janelas, não uma.
 *
 * `OCIOSA` é quanto tempo a sessão sobrevive sem uso e é renovada a cada
 * requisição; `ABSOLUTA` é o teto que nenhuma renovação ultrapassa. Só a
 * absoluta é o que havia antes: uma sessão de 30 dias que nunca expirava por
 * inatividade, então um cookie copiado valia um mês inteiro.
 */
const OCIOSA_MS = Number(process.env.APP_SESSAO_OCIOSA_HORAS ?? 12) * 3600 * 1000;
const ABSOLUTA_MS = Number(process.env.APP_SESSAO_HORAS ?? 720) * 3600 * 1000;

export const authLigada = () => SENHA.length > 0;
export const COOKIE = 'radar_sessao';

/** Comparação em tempo constante: `===` vaza o tamanho do prefixo correto. */
function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * As duas comparações rodam SEMPRE, mesmo com o usuário errado. Sair antes
 * quando só o usuário não bate revelaria, pelo tempo de resposta, qual dos
 * dois campos está correto.
 */
export function papelDasCredenciais(usuario: string, senha: string): Papel | null {
  if (!authLigada()) return null;
  // As DUAS contas são conferidas sempre, mesmo quando a primeira já bateu.
  // Sair cedo reabriria pelo tempo de resposta a informação de qual conta existe.
  const admin = iguais(String(usuario ?? ''), USUARIO) && iguais(String(senha ?? ''), SENHA);
  const comum =
    SENHA_COMUM.length > 0 &&
    iguais(String(usuario ?? ''), USUARIO_COMUM) &&
    iguais(String(senha ?? ''), SENHA_COMUM);
  if (admin) return 'admin';
  if (comum) return 'comum';
  return null;
}

/**
 * O papel vai DENTRO do token e entra no HMAC. É o que impede o cliente de se
 * promover a admin: sem o segredo do servidor não há como reassinar.
 * O formato mudou de 2 para 3 partes, então cookie antigo é rejeitado sozinho
 * pelo parse — todo mundo desloga uma vez, e não fica código de compatibilidade.
 */
export function criarToken(papel: Papel, sub?: string | null, nasceu = Date.now()): string {
  const expira = Date.now() + OCIOSA_MS;
  // `sub` é o identificador do provedor OIDC; vazio nas sessões do portão de
  // senha, que não vêm de provedor nenhum. Ele e o `nasceu` vão DENTRO do HMAC:
  // sem isso o cliente trocaria o sub para assumir outra conta, ou o nasceu
  // para fugir do teto absoluto renovando para sempre.
  const s = sub ?? '';
  const assinatura = createHmac('sha256', SEGREDO).update(`${nasceu}:${expira}:${papel}:${s}`).digest('hex');
  return `${nasceu}.${expira}.${papel}.${Buffer.from(s).toString('base64url')}.${assinatura}`;
}

export interface Sessao {
  valido: boolean;
  papel: Papel | null;
  sub: string | null;
  /** Momento do login. É o que o teto absoluto mede, e por isso não se renova. */
  nasceu: number;
  /** Fim da janela de ociosidade deste cookie. */
  expiraEm: number;
  /** Por que caiu, quando caiu. A tela de login mostra o motivo em vez de um formulário mudo. */
  motivo: 'ok' | 'ausente' | 'malformado' | 'ocioso' | 'expirado' | 'assinatura';
}

export function lerToken(token?: string | null): Sessao {
  const ruim = (motivo: Sessao['motivo']): Sessao => ({ valido: false, papel: null, sub: null, nasceu: 0, expiraEm: 0, motivo });
  if (!token) return ruim('ausente');
  // Cinco partes. Cada mudança de formato invalida os cookies do formato
  // anterior sozinha, pelo parse: todos deslogam uma vez e não sobra código de
  // compatibilidade para manter depois.
  const [nasceuS, expira, papel, subB64, assinatura] = String(token).split('.');
  if (!nasceuS || !expira || !papel || subB64 === undefined || !assinatura) return ruim('malformado');
  if (papel !== 'admin' && papel !== 'comum') return ruim('malformado');
  const nasceu = Number(nasceuS);
  if (!Number.isFinite(nasceu)) return ruim('malformado');
  let sub = '';
  try {
    sub = Buffer.from(subB64, 'base64url').toString('utf8');
  } catch {
    return ruim('malformado');
  }
  // A assinatura é conferida ANTES das datas: sem isso um token forjado com
  // data válida receberia a resposta "expirado", que confirma o formato ao
  // atacante em vez de recusar sem informação.
  const esperada = createHmac('sha256', SEGREDO).update(`${nasceu}:${expira}:${papel}:${sub}`).digest('hex');
  if (!iguais(assinatura, esperada)) return ruim('assinatura');
  if (Number(expira) < Date.now()) return ruim('ocioso');
  if (Date.now() - nasceu > ABSOLUTA_MS) return ruim('expirado');
  return { valido: true, papel, sub: sub || null, nasceu, expiraEm: Number(expira), motivo: 'ok' };
}

/**
 * A sessão deve ser renovada agora?
 *
 * Reescrever o cookie a cada requisição significaria um Set-Cookie em toda
 * chamada de API, inclusive nas dezenas que uma tela faz ao abrir. Renovar só
 * quando já passou um terço da janela mantém o efeito deslizante com uma
 * fração da escrita.
 */
export function precisaRenovar(s: Sessao): boolean {
  return s.valido && s.expiraEm - Date.now() < OCIOSA_MS * (2 / 3);
}

export const JANELAS = { ociosaMs: OCIOSA_MS, absolutaMs: ABSOLUTA_MS };
