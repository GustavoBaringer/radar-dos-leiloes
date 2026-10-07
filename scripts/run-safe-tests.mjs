import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'scripts/teste-classificacao-filtros.ts',
  'scripts/teste-descoberta-associacao.ts',
  'scripts/teste-slug.ts',
  'scripts/teste-search-query-fastify.ts',
  'scripts/teste-vlance-condicao.ts',
  'scripts/teste-antibot-frontend-state.ts',
  'scripts/teste-antibot-resources.ts',
  'scripts/teste-antibot-challenge.ts',
  'scripts/teste-antibot-operations.ts',
  'scripts/teste-antibot-account-context.ts',
  'scripts/teste-antibot-images.ts',
  'scripts/teste-antibot-data.ts',
  'scripts/teste-backfill-classificacao.ts',
  'scripts/teste-tenant-rotation.ts',
  'scripts/teste-antibot-ws.ts',
  'scripts/teste-brands-contrato.ts',
  'scripts/teste-host-contrato.mjs',
];

const coverage = process.argv.includes('--coverage');
const args = ['--import', 'tsx'];
if (coverage) args.push('--experimental-test-coverage', '--test-coverage-include=src/**/*.ts');
args.push('--test', ...files);
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
