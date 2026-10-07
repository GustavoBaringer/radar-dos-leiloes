import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HttpPaths { projectRoot: string; webRoot: string; appDist: string; certDir: string; dataDir: string }

export function resolveHttpPaths(moduleUrl: string): HttpPaths {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const compiled = basename(dirname(moduleDir)) === 'dist';
  const projectRoot = resolve(moduleDir, compiled ? '../..' : '..');
  const webRoot = resolve(projectRoot, compiled ? 'dist/src/web' : 'src/web');
  return {
    projectRoot,
    webRoot,
    appDist: resolve(projectRoot, 'app-busca/dist'),
    certDir: resolve(projectRoot, 'certs'),
    dataDir: resolve(projectRoot, 'data'),
  };
}
