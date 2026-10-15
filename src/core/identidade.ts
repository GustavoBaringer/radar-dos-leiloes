import { defaultIdentityService } from '../bootstrap/identity-composition.js';

export { ANONIMO } from '../domain/identity/identidade.js';
export type { Identidade } from '../domain/identity/identidade.js';
export const garantirUsuario = defaultIdentityService.garantirUsuario.bind(defaultIdentityService);
export const identidadePorSub = defaultIdentityService.identidadePorSub.bind(defaultIdentityService);
export const usuarioDoPortao = defaultIdentityService.usuarioDoPortao.bind(defaultIdentityService);
