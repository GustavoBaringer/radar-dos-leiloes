import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

const name = 'radar-nest-migration-auth';
const image = 'quay.io/keycloak/keycloak:26.0';
const base = 'http://127.0.0.1:58081';
const realm = 'radar-migration-test';
const issuer = `${base}/realms/${realm}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'test/fixtures/keycloak');
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim() ?? `docker ${args[0]} failed`);
  return result.stdout.trim();
}

async function check() {
  const deadline = Date.now() + 150_000;
  let discovery;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) { discovery = await response.json(); break; }
    } catch {}
    await delay(1500);
  }
  if (!discovery) throw new Error('Keycloak discovery was not ready within 150 seconds');
  if (discovery.issuer !== issuer || !discovery.jwks_uri?.startsWith(`${issuer}/`)) throw new Error('Unexpected discovery issuer/JWKS URI');
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  for (const [username, password, adminExpected] of [
    ['radar-admin-test', 'radar-test-password', true], ['radar-user-test', 'radar-user-password', false],
  ]) {
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'radar-test-web', client_secret: 'radar-test-client-secret', username, password }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Fixture token request failed for ${username} (${response.status})`);
    const token = (await response.json()).access_token;
    if (!token) throw new Error('Token endpoint did not return access_token');
    const { payload } = await jwtVerify(token, jwks, { issuer });
    const roles = payload.realm_access?.roles ?? [];
    if (roles.includes('radar-admin') !== adminExpected || !roles.includes('radar-user')) throw new Error(`Unexpected fixture role mapping for ${username}`);
    console.log(`Verified signed token: ${username}; roles=${roles.join(',')}`);
  }
  console.log(`OIDC fixture verified: issuer=${issuer}; JWKS verified; fixture users passed`);
}

async function up() {
  const existing = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
  if (existing.status === 0) {
    const info = JSON.parse(existing.stdout)[0];
    const ports = info.NetworkSettings.Ports?.['8080/tcp'] ?? [];
    if (info.Config.Image !== image || !ports.some(p => p.HostIp === '127.0.0.1' && p.HostPort === '58081')) throw new Error(`Refusing to reuse foreign container named ${name}`);
    if (info.State.Status !== 'running') docker(['start', name]);
  } else {
    const occupied = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.listen(58081, '127.0.0.1', () => server.close(() => resolve(false)));
    });
    if (occupied) throw new Error('127.0.0.1:58081 is occupied; refusing to bind');
    docker(['run', '-d', '--name', name, '--memory=768m', '-p', '127.0.0.1:58081:8080',
      '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=fixture-admin', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD=fixture-bootstrap-password',
      '-e', `KC_HOSTNAME=${base}`, '-v', `${fixture}:/opt/keycloak/data/import:ro`, image,
      'start-dev', '--import-realm']);
  }
  await check();
}

const command = process.argv[2];
if (!['up', 'check'].includes(command) || process.argv.length !== 3) {
  console.error('Usage: node scripts/test-environment.mjs <up|check>'); process.exitCode = 2;
} else {
  try { if (command === 'up') await up(); else await check(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
