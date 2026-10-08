import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readTemplate = (name: string) => readFile(new URL(`../infra/antibot/${name}`, import.meta.url), 'utf8');

test('Nginx example is loopback-only upstream, domain-correct, and overwrites client XFF', async () => {
  const nginx = await readTemplate('nginx.conf.example');
  assert.match(nginx, /server_name radardeleiloes\.app\.br www\.radardeleiloes\.app\.br;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:4500;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(nginx, /proxy_set_header X-Forwarded-For\s+\$proxy_add_x_forwarded_for/);
  assert.match(nginx, /include \/etc\/nginx\/operator\/trusted-cloudflare-ips\.conf;/);
  assert.match(nginx, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/radardeleiloes\.app\.br\/privkey\.pem/);
  assert.doesNotMatch(nginx, /radardosleiloes\.app\.br/);
});

test('Redis template is separate, local, bounded and fail-closed on missing private ACL include', async () => {
  const redis = await readTemplate('redis.conf.example');
  assert.match(redis, /^bind 127\.0\.0\.1 ::1$/m);
  assert.match(redis, /^port 6381$/m);
  assert.match(redis, /^maxmemory 128mb$/m);
  assert.match(redis, /^maxmemory-policy noeviction$/m);
  assert.match(redis, /^appendonly yes$/m);
  assert.match(redis, /^appendfsync everysec$/m);
  assert.match(redis, /^include \/etc\/redis-antibot\/operator-private-acl\.conf$/m);
  assert.doesNotMatch(redis, /^port 6380$/m);
});

test('production profile requires enforce modes and leaves credentials and manual origin ACK blank', async () => {
  const env = await readTemplate('production.env.example');
  for (const setting of [
    'NODE_ENV=production', 'ANTIBOT_MODE=enforce', 'ANTIBOT_CHALLENGE_MODE=enforce',
    'TURNSTILE_SITE_KEY=', 'TURNSTILE_SECRET_KEY=', 'ANTIBOT_REDIS_URL=',
    'ANTIBOT_ORIGIN_PROTECTION_CONFIRMED=',
  ]) assert.ok(env.split(/\r?\n/).includes(setting), `missing ${setting}`);
  assert.match(env, /^ANTIBOT_TRUST_PROXY_CIDRS=127\.0\.0\.1\/32,::1\/128$/m);
  assert.match(env, /radardeleiloes\.app\.br,www\.radardeleiloes\.app\.br/);
  assert.doesNotMatch(env, /radardosleiloes\.app\.br/);
  assert.doesNotMatch(env, /(?:sk_live_|secret-[A-Za-z0-9]{12,})/i);
});

test('deployment templates are explicitly inert and never start publication/tunnel services', async () => {
  const [readme, nginx, redis, service, env, cloudflare] = await Promise.all([
    readTemplate('README.md'), readTemplate('nginx.conf.example'), readTemplate('redis.conf.example'),
    readTemplate('radar.service.example'), readTemplate('production.env.example'), readTemplate('cloudflare-rules.md'),
  ]);
  for (const text of [readme, nginx, redis, service, env, cloudflare]) {
    assert.match(text, /INERTE|não aplicada|não instalar/i);
    assert.doesNotMatch(text, /cloudflared\s+tunnel|ngrok\s+|ssh\s+-R\s|systemctl\s+(?:enable|start)|docker\s+(?:run|compose\s+up)|redis-server\s/i);
  }
  assert.match(readme, /não copiar para diretórios ativos/i);
  assert.match(readme, /não está implantada/i);
  assert.match(cloudflare, /não aplicar managed challenge.*JSON/i);
  assert.match(cloudflare, /verified bots/i);
});
