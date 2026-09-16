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
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;

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
export function criarToken(papel: Papel, sub?: string | null): string {
  const expira = Date.now() + VALIDADE_MS;
  // `sub` é o identificador do provedor OIDC; vazio nas sessões do portão de
  // senha, que não vêm de provedor nenhum. Vai DENTRO do HMAC junto com o
  // papel: sem isso o cliente trocaria o sub e assumiria a conta de outro.
  const s = sub ?? '';
  const assinatura = createHmac('sha256', SEGREDO).update(`${expira}:${papel}:${s}`).digest('hex');
  return `${expira}.${papel}.${Buffer.from(s).toString('base64url')}.${assinatura}`;
}

export function lerToken(token?: string | null): { valido: boolean; papel: Papel | null; sub: string | null } {
  const invalido = { valido: false, papel: null, sub: null };
  if (!token) return invalido;
  // Quatro partes. O formato anterior tinha três, então cookie velho é
  // rejeitado sozinho pelo parse: todos deslogam uma vez e não fica código de
  // compatibilidade para manter.
  const [expira, papel, subB64, assinatura] = String(token).split('.');
  if (!expira || !papel || subB64 === undefined || !assinatura) return invalido;
  if (papel !== 'admin' && papel !== 'comum') return invalido;
  if (Number(expira) < Date.now()) return invalido;
  let sub = '';
  try {
    sub = Buffer.from(subB64, 'base64url').toString('utf8');
  } catch {
    return invalido;
  }
  const esperada = createHmac('sha256', SEGREDO).update(`${expira}:${papel}:${sub}`).digest('hex');
  return iguais(assinatura, esperada) ? { valido: true, papel, sub: sub || null } : invalido;
}
