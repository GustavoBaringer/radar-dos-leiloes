import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const compose = readFileSync(new URL('../docker-compose.production.yml', import.meta.url), 'utf8');
const env = readFileSync(new URL('../infra/dokploy/production.env.example', import.meta.url), 'utf8');
const init = readFileSync(new URL('../infra/dokploy/init-databases.sh', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../infra/dokploy/README.md', import.meta.url), 'utf8');
const keycloakDockerfile = readFileSync(new URL('../infra/dokploy/Dockerfile.keycloak', import.meta.url), 'utf8');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

assert.match(compose, /internal:\s*true/);
assert.doesNotMatch(compose, /^\s+ports:/m);
assert.doesNotMatch(compose, /network_mode:\s*host/);
assert.match(compose, /--maxmemory 128mb --maxmemory-policy noeviction/);
assert.match(compose, /--appendonly yes/);
assert.match(compose, /ANTIBOT_MODE: enforce/);
assert.match(compose, /ANTIBOT_CHALLENGE_MODE: enforce/);
for (const key of [
  'APP_SESSAO_SEGREDO', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_HOSTNAMES',
  'ANTIBOT_TRUST_PROXY_CIDRS', 'ANTIBOT_ORIGIN_PROTECTION_CONFIRMED',
]) assert.match(compose, new RegExp(`${key}: \\$\\{${key}:-\\}`));
assert.match(compose, /:\s*"\$\$\{APP_SESSAO_SEGREDO:\?Set APP_SESSAO_SEGREDO\}"/);
assert.match(compose, /:\s*"\$\$\{ANTIBOT_TRUST_PROXY_CIDRS:\?Set verified narrow proxy CIDRs\}"/);
assert.match(compose, /:\s*"\$\$\{ANTIBOT_ORIGIN_PROTECTION_CONFIRMED:\?Confirm origin protection before start\}"/);
assert.match(compose, /\[ "\$\$\{ANTIBOT_ORIGIN_PROTECTION_CONFIRMED\}" = 1 \]/);
assert.match(compose, /radardeleiloes\.app\.br/);
assert.doesNotMatch(compose, /radardosleiloes/);
assert.match(compose, /--hostname=https:\/\/auth\.radardeleiloes\.app\.br/);
assert.match(compose, /KEYCLOAK_VERSION:\s*\$\{KEYCLOAK_VERSION:\?/);
assert.match(compose, /image:\s*radar-keycloak:\$\{KEYCLOAK_VERSION:\?/);
assert.match(compose, /OIDC_ROLE_ADMIN: radar-admin/);
assert.match(compose, /OIDC_CLIENT_SECRET: \$\{OIDC_CLIENT_SECRET:-\}/);
assert.match(compose, /:\s*"\$\$\{OIDC_CLIENT_SECRET:\?Set OIDC_CLIENT_SECRET\}"/);
assert.match(compose, /REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD/);
assert.match(compose, /ENCERRAR_POR_AUSENCIA: "0"/);
assert.match(compose, /start.*--optimized/);
assert.doesNotMatch(compose, /--health-enabled|KC_HOSTNAME_STRICT_HTTPS/);
assert.match(compose, /HTTP\/1\.1\\\\r\\\\n/);
assert.match(compose, /r\.status===200/);
assert.match(compose, /node.*dist\/src\/server\.js/);
assert.doesNotMatch(compose, /^\s{2,}\w+worker\w*:/m);
assert.match(env, /^TURNSTILE_SITE_KEY=$/m);
assert.match(env, /^OIDC_CLIENT_SECRET=$/m);
assert.match(env, /^KEYCLOAK_VERSION=$/m);
assert.match(env, /^TURNSTILE_SECRET_KEY=$/m);
assert.match(env, /^TURNSTILE_HOSTNAMES=radardeleiloes\.app\.br$/m);
assert.match(env, /radardeleiloes\.app\.br/);
assert.match(env, /^ANTIBOT_TRUST_PROXY_CIDRS=$/m);
assert.match(env, /^ANTIBOT_ORIGIN_PROTECTION_CONFIRMED=$/m);
assert.match(init, /:'radar_password'/);
assert.match(init, /:'keycloak_password'/);
assert.doesNotMatch(init, /db\/0[0-9]+_.*\.sql|migrate\.ts/);
assert.match(docs, /radardeleiloes\.app\.br/);
assert.doesNotMatch(docs, /radardosleiloes/);
assert.match(docs, /26\.x\.y/);
assert.match(docs, /OIDC_CLIENT_SECRET/);
assert.match(docs, /obrigatório antes de iniciar `web`/);
assert.match(docs, /não use `latest`/);
assert.match(docs, /validar build da imagem e runtime/);
assert.equal((keycloakDockerfile.match(/^FROM quay\.io\/keycloak\/keycloak:\$\{KEYCLOAK_VERSION\}/gm) ?? []).length, 2);
assert.doesNotMatch(keycloakDockerfile, /keycloak:26\.0/);

const composeEnv = {
  COMPOSE_DISABLE_ENV_FILE: '1',
  PATH: process.env.PATH,
  PG_INIT_ADMIN_USER: 'bootstrap', PG_INIT_ADMIN_PASSWORD: 'synthetic-admin',
  RADAR_DB_PASSWORD: 'synthetic-radar', KEYCLOAK_DB_PASSWORD: 'synthetic-keycloak',
  REDIS_PASSWORD: 'synthetic-redis', KEYCLOAK_VERSION: '26.8.0',
  KC_BOOTSTRAP_ADMIN_USERNAME: 'synthetic-admin', KC_BOOTSTRAP_ADMIN_PASSWORD: 'synthetic-password',
  APP_SESSAO_SEGREDO: '', TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '', TURNSTILE_HOSTNAMES: '',
  OIDC_CLIENT_SECRET: '',
  ANTIBOT_TRUST_PROXY_CIDRS: '', ANTIBOT_ORIGIN_PROTECTION_CONFIRMED: '',
};
const rendered = spawnSync('docker', ['compose', '-f', 'docker-compose.production.yml', 'config', '--format', 'json'], {
  cwd: root, env: composeEnv, encoding: 'utf8',
});
assert.equal(rendered.status, 0, rendered.stderr);
const web = JSON.parse(rendered.stdout).services.web;
const webCommand = web.command;
assert.deepEqual(webCommand.slice(0, 2), ['sh', '-ec']);
assert.match(webCommand[2], /exec node dist\/src\/server\.js/);
// Compose config retains $$ escapes so Compose itself will not expand these
// shell checks; at container runtime Compose passes each as one literal $.
const runtimeWebCommand = webCommand.map((part) => part.replaceAll('$$', '$'));

const temp = mkdtempSync(join('/tmp/opencode', 'dokploy-web-guard-'));
try {
  const stubNode = join(temp, 'node');
  writeFileSync(stubNode, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NODE_STUB_LOG"\n');
  chmodSync(stubNode, 0o755);
  const runGuard = (vars) => spawnSync(runtimeWebCommand[0], [...runtimeWebCommand.slice(1)], {
    cwd: root,
    env: {
      PATH: `${temp}:${process.env.PATH}`,
      NODE_STUB_LOG: join(temp, 'node-called'),
      ...vars,
    },
    encoding: 'utf8',
  });
  const valid = {
    APP_SESSAO_SEGREDO: 'synthetic-session', OIDC_CLIENT_SECRET: 'synthetic-oidc-secret',
    TURNSTILE_SITE_KEY: 'synthetic-site',
    TURNSTILE_SECRET_KEY: 'synthetic-secret', TURNSTILE_HOSTNAMES: 'example.invalid',
    ANTIBOT_TRUST_PROXY_CIDRS: '192.0.2.10/32', ANTIBOT_ORIGIN_PROTECTION_CONFIRMED: '1',
  };
  for (const missing of [
    'APP_SESSAO_SEGREDO', 'OIDC_CLIENT_SECRET', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_HOSTNAMES',
    'ANTIBOT_TRUST_PROXY_CIDRS', 'ANTIBOT_ORIGIN_PROTECTION_CONFIRMED',
  ]) {
    const result = runGuard({ ...valid, [missing]: '' });
    assert.notEqual(result.status, 0, `${missing} must block web startup`);
  }
  const missingOidc = { ...valid };
  delete missingOidc.OIDC_CLIENT_SECRET;
  const oidcUnset = runGuard(missingOidc);
  assert.notEqual(oidcUnset.status, 0, 'unset OIDC_CLIENT_SECRET must block web startup');
  assert.equal(existsSync(join(temp, 'node-called')), false, 'invalid configuration must not exec Node');
  const badAck = runGuard({ ...valid, ANTIBOT_ORIGIN_PROTECTION_CONFIRMED: 'yes' });
  assert.notEqual(badAck.status, 0, 'non-1 origin acknowledgement must block web startup');
  const accepted = runGuard(valid);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(readFileSync(join(temp, 'node-called'), 'utf8').trim(), 'dist/src/server.js');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('Dokploy production config static checks passed');
