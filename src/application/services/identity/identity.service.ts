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
import { Inject, Injectable } from '@nestjs/common';
import type { Papel } from '../../../infra/auth/session.js';
import { ANONIMO, type Identidade } from '../../../domain/identity/identidade.js';
import { IdentityRepository } from '../../../infra/database/repositories/identity.repository.js';

const TTL_CACHE_MS = 30_000;

@Injectable()
export class IdentityService {
  readonly ANONIMO = ANONIMO;
  private readonly porSub = new Map<string, { em: number; id: Identidade }>();
  private readonly cache = new Map<Papel, Identidade>();

  constructor(@Inject(IdentityRepository) private readonly repository: IdentityRepository) {}

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
async garantirUsuario(dados: {
  sub: string;
  email?: string | null;
  nome?: string | null;
  papel: Papel;
}): Promise<Identidade> {
  const u = await this.repository.garantirUsuario(dados);
  return { userId: Number(u.id), sub: u.sub, email: u.email, nome: u.nome, papel: u.papel };
}

/**
 * Identidade de uma sessão OIDC já estabelecida.
 *
 * É SELECT, não upsert: a linha nasce no callback do login, e escrever a cada
 * requisição colocaria um UPDATE no caminho de toda chamada de API. O cache é
 * curto de propósito — mudar o papel de alguém não deve exigir reiniciar.
 */
async identidadePorSub(sub: string): Promise<Identidade | null> {
  const guardado = this.porSub.get(sub);
  if (guardado && Date.now() - guardado.em < TTL_CACHE_MS) return guardado.id;
  const u = await this.repository.identidadePorSub(sub);
  if (!u) return null;
  const id: Identidade = { userId: Number(u.id), sub, email: u.email, nome: u.nome, papel: u.papel };
  this.porSub.set(sub, { em: Date.now(), id });
  return id;
}

/**
 * A identidade das contas do portão de senha, criadas pela migração 011.
 * Elas têm `sub` NULL de propósito: não vêm de provedor nenhum, e é assim que
 * os dois modos coexistem enquanto a migração para OIDC não termina.
 */
async usuarioDoPortao(papel: Papel): Promise<Identidade> {
  const guardado = this.cache.get(papel);
  if (guardado) return guardado;
  const u = await this.repository.usuarioDoPortao(papel);
  if (!u) throw new Error(`conta do portão para o papel "${papel}" não existe — rode db/011_usuarios.sql`);
  const id: Identidade = { userId: Number(u.id), sub: null, email: null, nome: u.nome, papel };
  this.cache.set(papel, id);
  return id;
}

}
