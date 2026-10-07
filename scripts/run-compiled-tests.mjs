import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFiles = [
  'scripts/teste-host-contrato.mjs',
  'scripts/teste-bootstrap-lifecycle.mjs',
].map((file) => resolve(projectRoot, file));
for (const testFile of testFiles) {
  if (!existsSync(testFile)) {
    console.error(`Missing ${testFile}`);
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: projectRoot,
  env: { ...process.env, HOST_VARIANT: 'compiled' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
