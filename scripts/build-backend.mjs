import { cpSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prisma = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const generate = spawnSync(process.execPath, [prisma, 'generate'], {
  cwd: projectRoot,
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://generate:generate@127.0.0.1:5432/generate' },
  stdio: 'inherit',
});
if (generate.error) throw generate.error;
if (generate.status !== 0) process.exit(generate.status ?? 1);

const tsc = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-p', resolve(projectRoot, 'tsconfig.backend.json')], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const webOutput = resolve(projectRoot, 'dist/src/web');
mkdirSync(webOutput, { recursive: true });
cpSync(resolve(projectRoot, 'src/web'), webOutput, { recursive: true });
