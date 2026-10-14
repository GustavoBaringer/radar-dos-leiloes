import type { RadarHttpOptions } from '../infra/http/http-contracts.js';
import { resolveHttpPaths } from './paths.js';
import { createNativeHttpDependencies } from './native-http-dependencies.js';

export async function createNativeHttpOptions(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = new URL('../server.js', import.meta.url).href,
): Promise<RadarHttpOptions> {
  const oidc = await import('../core/oidc.js');
  if (!oidc.oidcLigado()) throw new Error('FATAL: OIDC desligado. Configure OIDC_ISSUER no ambiente.');
  return { env, paths: resolveHttpPaths(moduleUrl), dependencies: await createNativeHttpDependencies(oidc) };
}
