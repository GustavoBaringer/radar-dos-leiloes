/**
 * Fronteira de identidade.
 *
 * O resto do sistema não sabe (e não deve saber) se a pessoa entrou pelo portão
 * de senha ou por um provedor OIDC. Ele pergunta "quem é o dono desta
 * requisição" e recebe uma `Identidade` com `userId` — a chave estrangeira que
 * alerts, saved_searches e push_subscriptions usam.
 *
 * É esta indireção que torna a escolha de provedor reversível: trocar Keycloak
 * por Cognito é trocar `issuer` e `client_id`, porque os dois são OIDC, e nada
 * fora deste arquivo e do oidc.ts encosta nisso.
 */
import { query } from './db.js';
import type { Papel } from './auth.js';

export interface Identidade {
  userId: number;
  sub: string | null;
  email: string | null;
  nome: string | null;
  papel: Papel;
}

/**
 * Garante a linha de `users` para uma identidade do provedor e devolve a
 * `Identidade` resolvida.
 *
 * O `sub` é a chave, não o e-mail: e-mail no Keycloak é editável pelo próprio
 * usuário, e casar por e-mail deixaria alguém herdar os alertas de outra pessoa
 * trocando o endereço para um que já existe na nossa base.
 *
 * O papel vem do provedor a cada login e é reescrito aqui: tirar a role no
 * Keycloak precisa ter efeito na próxima entrada, não só quando a linha nasce.
 */
export async function garantirUsuario(dados: {
  sub: string;
  email?: string | null;
  nome?: string | null;
  papel: Papel;
}): Promise<Identidade> {
  const [u] = await query<{ id: string; sub: string; email: string | null; nome: string | null; papel: Papel }>(
    `INSERT INTO users (sub, email, nome, papel, visto_em)
     VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4, now())
     ON CONFLICT (sub) WHERE sub IS NOT NULL
     DO UPDATE SET email = COALESCE(NULLIF(EXCLUDED.email,''), users.email),
                   nome  = COALESCE(NULLIF(EXCLUDED.nome,''),  users.nome),
                   papel = EXCLUDED.papel,
                   visto_em = now()
     RETURNING id, sub, email, nome, papel`,
    [dados.sub, dados.email ?? '', dados.nome ?? '', dados.papel],
  );
  return { userId: Number(u.id), sub: u.sub, email: u.email, nome: u.nome, papel: u.papel };
}

/**
 * Identidade de uma sessão OIDC já estabelecida.
 *
 * É SELECT, não upsert: a linha nasce no callback do login, e escrever a cada
 * requisição colocaria um UPDATE no caminho de toda chamada de API. O cache é
 * curto de propósito — mudar o papel de alguém não deve exigir reiniciar.
 */
const porSub = new Map<string, { em: number; id: Identidade }>();
const TTL_CACHE_MS = 30_000;
export async function identidadePorSub(sub: string): Promise<Identidade | null> {
  const guardado = porSub.get(sub);
  if (guardado && Date.now() - guardado.em < TTL_CACHE_MS) return guardado.id;
  const [u] = await query<{ id: string; email: string | null; nome: string | null; papel: Papel }>(
    `SELECT id, email, nome, papel FROM users WHERE sub = $1`,
    [sub],
  );
  if (!u) return null;
  const id: Identidade = { userId: Number(u.id), sub, email: u.email, nome: u.nome, papel: u.papel };
  porSub.set(sub, { em: Date.now(), id });
  return id;
}

/**
 * A identidade das contas do portão de senha, criadas pela migração 011.
 * Elas têm `sub` NULL de propósito: não vêm de provedor nenhum, e é assim que
 * os dois modos coexistem enquanto a migração para OIDC não termina.
 */
const cache = new Map<Papel, Identidade>();
export async function usuarioDoPortao(papel: Papel): Promise<Identidade> {
  const guardado = cache.get(papel);
  if (guardado) return guardado;
  const [u] = await query<{ id: string; nome: string | null }>(
    `SELECT id, nome FROM users WHERE papel = $1 AND sub IS NULL ORDER BY id LIMIT 1`,
    [papel],
  );
  if (!u) throw new Error(`conta do portão para o papel "${papel}" não existe — rode db/011_usuarios.sql`);
  const id: Identidade = { userId: Number(u.id), sub: null, email: null, nome: u.nome, papel };
  cache.set(papel, id);
  return id;
}

/**
 * Identidade do visitante anônimo do catálogo público (SEO_PUBLICO=1).
 * `userId` é 0 — nenhuma linha de `users` tem esse id, então toda consulta
 * filtrada por dono devolve vazio em vez de devolver o do administrador.
 */
export const ANONIMO: Identidade = { userId: 0, sub: null, email: null, nome: null, papel: 'comum' };
