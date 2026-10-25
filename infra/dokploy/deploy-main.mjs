import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chownSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run through flock from Dokploy; builds both services before touching live containers.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.RADAR_RUNTIME_DIR ?? '/etc/dokploy/radar-runtime/059af2b';
const docker = (args, quiet = false) => execFileSync('docker', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function ensureRawWebEnv(block) {
  const lines = block.split('\n');
  const key = lines.findIndex(line => /^ {4}env_file:\s*$/.test(line));
  if (key < 0) {
    if (lines.some(line => /^ {4}env_file:/.test(line))) throw Error('Unsupported inline web env_file');
    return block.replace(/(\n    networks:)/, '\n    env_file:\n    - path: web.env\n      format: raw$1');
  }
  let end = key + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) { end++; continue; }
    const indent = line.match(/^ */)[0].length;
    if (indent > 4 || (indent === 4 && line.trimStart().startsWith('-'))) { end++; continue; }
    break;
  }
  const entries = lines.slice(key + 1, end);
  if (entries.some(line => line.includes('#') || (line.trim() && !/^ {4,8}(?:-|(?:path|format|required):)/.test(line)))
    || /^ {4}#/.test(lines[end] ?? '')) {
    throw Error('Unsupported web env_file layout');
  }
  for (let i = key + 1; i < end; i++) {
    if (/web\.env/.test(lines[i]) && !/^ {4,6}- (?:path: )?web\.env$/.test(lines[i])) {
      throw Error('Unsupported web.env entry');
    }
    if (/^ {4,6}- (?:path: )?web\.env$/.test(lines[i])) {
      const indent = lines[i].match(/^ */)[0];
      if (/path:/.test(lines[i])) {
        let next = i + 1;
        while (next < end && lines[next].match(/^ */)[0].length > indent.length && !/^\s*-/.test(lines[next])) next++;
        const format = lines.findIndex((line, index) => index > i && index < next && /^\s*format\s*:/.test(line));
        if (format >= 0) lines[format] = `${indent}  format: raw`;
        else lines.splice(next, 0, `${indent}  format: raw`);
      } else {
        lines.splice(i, 1, `${indent}- path: web.env`, `${indent}  format: raw`);
      }
      return lines.join('\n');
    }
  }
  const itemIndent = lines.slice(key + 1, end).find(line => /^\s*-\s/.test(line))?.match(/^ */)[0] ?? '    ';
  lines.splice(end, 0, `${itemIndent}- path: web.env`, `${itemIndent}  format: raw`);
  return lines.join('\n');
}
const revision = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/.test(revision) || revision !== git('rev-parse', 'origin/main')) throw Error('Deploy requires the fetched main revision');
const release = join(dirname(runtime), 'releases', revision);
const source = join(release, 'source');
mkdirSync(source, { recursive: true });
const archive = join(release, 'source.tar');
git('archive', '--format=tar', `--output=${archive}`, revision);
execFileSync('tar', ['-xf', archive, '-C', source]);
unlinkSync(archive);
const webFile = join(runtime, 'compose.yml');
const workerFile = join(runtime, 'workers.yml');
const beforeWeb = readFileSync(webFile, 'utf8');
const beforeWorker = readFileSync(workerFile, 'utf8');
writeFileSync(join(release, 'compose-before.yml'), beforeWeb, { mode: 0o600 });
writeFileSync(join(release, 'workers-before.yml'), beforeWorker, { mode: 0o600 });
const compose = (project, file, service) => docker(['compose', '-p', project, '--env-file', join(runtime, 'production.env'), '-f', file,
  'up', '-d', '--no-deps', '--no-build', '--pull', 'never', service]);
const inspect = (name) => JSON.parse(docker(['inspect', name], true))[0];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function health(name) {
  for (let i = 0; i < 100; i++) {
    const state = inspect(name).State;
    if (state.Health?.Status === 'healthy') return;
    if (!state.Running || state.Health?.Status === 'unhealthy') throw Error(`${name} not healthy`);
    await wait(2000);
  }
  throw Error(`${name} health timeout`);
}
const webTag = `radar-web:${revision}`;
const workerTag = `radar-worker:${revision}`;
for (const [target, tag] of [['web', webTag], ['worker', workerTag]]) {
  docker(['build', '--target', target, '--label', `org.opencontainers.image.revision=${revision}`, '-t', tag, source]);
}
const imageId = tag => docker(['image', 'inspect', tag, '--format', '{{.Id}}'], true).trim();
const webId = imageId(webTag), workerId = imageId(workerTag);
docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,mode=1777',
  '--memory', '512m', '--entrypoint', 'node', workerId, '--input-type=module', '-e', `
    import {chromium} from 'playwright-core';
    const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    try { const page=await browser.newPage(); await page.goto('about:blank'); console.log('worker Chromium smoke passed'); }
    finally { await browser.close(); }
  `]);
const deployKeys = [
  'NODE_ENV', 'NEST_BOOTSTRAP', 'RADAR_RUNTIME_ENV', 'RADAR_PUBLIC_DEPLOYMENT',
  'ONBOARDING_ENABLED', 'ONBOARDING_MODE', 'ONBOARDING_ALLOWED_EMAILS', 'ONBOARDING_PUBLIC_BASE_URL',
  'ONBOARDING_TOKEN_KEY', 'ONBOARDING_ACTIVATION_ENABLED', 'ONBOARDING_ACTIVATION_HTTP_ENABLED',
  'ONBOARDING_DISPATCH_ENABLED', 'ONBOARDING_CHECKOUT_EMAIL_ENABLED', 'ONBOARDING_ACTIVATION_EMAIL_ENABLED',
  'ASAAS_CHECKOUT_ENABLED', 'ASAAS_WEBHOOK_ENABLED', 'ASAAS_PAYMENT_PROCESSING_ENABLED',
  'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN', 'ASAAS_CHECKOUT_RETURN_URL',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
];
// Dokploy writes the saved environment to the checkout's .env; only the web service receives these keys.
const dokployEnv = new Map();
const dokployEnvPath = join(root, '.env');
if (existsSync(dokployEnvPath)) {
  for (const line of readFileSync(dokployEnvPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) dokployEnv.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
}
const webEnv = new Map();
for (const key of deployKeys) {
  const savedValue = dokployEnv.get(key);
  const value = key === 'ASAAS_API_KEY' && /^\\\$aact_hmlg_/.test(savedValue ?? '')
    ? savedValue.replace(/\\\$/g, '$')
    : savedValue ?? process.env[key];
  if (value !== undefined && value !== '') webEnv.set(key, value);
}
webEnv.set('NODE_ENV', 'staging');
webEnv.set('ONBOARDING_MODE', 'staging');
webEnv.set('NEST_BOOTSTRAP', '1');
webEnv.set('RADAR_PUBLIC_DEPLOYMENT', 'true');
const webEnvFile = join(runtime, 'web.env');
const previousWebEnv = existsSync(webEnvFile) ? readFileSync(webEnvFile) : null;
let webEnvWriteAttempted = false;
const restoreWebEnv = () => {
  if (!webEnvWriteAttempted) return;
  if (previousWebEnv === null) {
    if (existsSync(webEnvFile)) unlinkSync(webEnvFile);
  } else writeFileSync(webEnvFile, previousWebEnv);
  webEnvWriteAttempted = false;
};
const liveWeb = inspect('radar-stack-m9wohj-web-1');
const envFile = join(release, 'candidate.env');
const candidate = `radar-candidate-${revision.slice(0, 12)}`;
const candidateEnvMap = new Map();
for (const entry of (liveWeb.Config?.Env ?? [])) {
  const i = entry.indexOf('=');
  if (i > 0) candidateEnvMap.set(entry.slice(0, i), entry.slice(i + 1));
}
for (const [key, value] of webEnv) candidateEnvMap.set(key, value);
candidateEnvMap.set('IMAGE_METRICS_DIR', '/tmp/image-metrics');
// Secret environment exists only in a private temporary file; never echo it.
writeFileSync(envFile, Array.from(candidateEnvMap.entries()).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
try {
  docker(['create', '--name', candidate, '--env-file', envFile, '--network', 'radar-stack-m9wohj_backend',
    '--memory', '768m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--health-cmd', "node -e \"fetch('http://127.0.0.1:4500/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))\"",
    '--health-interval', '5s', '--health-start-period', '20s', '--health-retries', '6', webId]);
  docker(['network', 'connect', 'radar-stack-m9wohj_egress', candidate]);
  docker(['start', candidate]);
  await health(candidate);
  docker(['exec', candidate, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {POLICY_IDS} from './dist/src/core/antibot/config.js';
    import {ROUTE_POLICIES} from './dist/src/core/antibot/routes.js';
    assert.equal(POLICY_IDS.includes('image'),false); assert.equal(POLICY_IDS.includes('imageMiss'),false);
    assert.equal(ROUTE_POLICIES['GET /api/img'],undefined);
    for(let i=0;i<130;i++){const r=await fetch('http://127.0.0.1:4500/api/img');assert.equal(r.status,200);await r.arrayBuffer()}
    assert.equal((await fetch('http://127.0.0.1:4500/api/security/metrics')).status,401);
    console.log('candidate: landing, 130 image requests without minute quota, admin protection passed');
  `]);
} catch (err) {
  try {
    const logs = docker(['logs', '--tail', '100', candidate], true);
    console.error('=== CANDIDATE ERROR LOGS ===\n' + logs);
  } catch {}
  throw err;
} finally {
  docker(['rm', '-f', candidate]);
  unlinkSync(envFile);
}
const metricsDir = join(dirname(runtime), 'image-metrics');
mkdirSync(metricsDir, { recursive: true, mode: 0o700 });
chownSync(metricsDir, 1000, 1000);
// Replace only the web image and the worker image, retaining existing infrastructure/security settings.
let nextWeb = beforeWeb.replace(/(\n  web:\n[\s\S]*?\n    image:) [^\n]+/, `$1 ${webId}`)
  .replace(/\n      ANTIBOT_IMAGE(?:MISS)?_MAX: [^\n]+/g, '');
if (!nextWeb.includes(`image: ${webId}`)) throw Error('Web image replacement failed');
if (!nextWeb.includes('      IMAGE_METRICS_DIR:')) nextWeb = nextWeb.replace('      ANTIBOT_MODE: enforce', '      ANTIBOT_MODE: enforce\n      IMAGE_METRICS_DIR: /app/image-metrics');
if (!nextWeb.includes(`${metricsDir}:/app/image-metrics`)) nextWeb = nextWeb.replace(/(\n  web:\n[\s\S]*?)(\n    networks:)/,
  `$1\n    volumes:\n    - ${metricsDir}:/app/image-metrics$2`);
// Switch server entrypoint from legacy server.js to NestJS native host main.js
nextWeb = nextWeb.replace('exec node dist/src/server.js', 'exec node dist/src/main.js');
// Explicit web environment entries override env_file, so drop the keys web.env now owns.
nextWeb = nextWeb.replace(/(\n  web:\n[\s\S]*?)(?=\n  [A-Za-z0-9_-]+:\n|\n[A-Za-z]|$)/, block => {
  let web = block;
  for (const key of webEnv.keys()) web = web.replace(new RegExp(`\\n      ${key}: [^\\n]*`, 'g'), '');
  return ensureRawWebEnv(web);
});
const webBlock = nextWeb.match(/\n  web:\n[\s\S]*?(?=\n  [A-Za-z0-9_-]+:\n|\n[A-Za-z]|$)/)?.[0] ?? '';
if (!/^([ ]{4,6})- path: web\.env\n\1  format: raw$/m.test(webBlock)) throw Error('Raw web env_file injection failed');
const nextWorker = beforeWorker.replace(/(\n    image:) [^\n]+/, `$1 ${workerId}`);
if (!nextWorker.includes(`image: ${workerId}`)) throw Error('Worker image replacement failed');
// Exercise the actual Compose parser before queue drain or live compose-file replacement.
const preflightWebFile = join(runtime, `compose-preflight-${revision}.yml`);
try {
  webEnvWriteAttempted = true;
  writeFileSync(webEnvFile, [...webEnv].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(preflightWebFile, nextWeb, { mode: 0o600 });
  docker(['compose', '--env-file', join(runtime, 'production.env'), '-f', preflightWebFile, 'config', '--quiet'], true);
  docker(['compose', '--env-file', join(runtime, 'production.env'), '-f', workerFile, 'config', '--quiet'], true);
  if (existsSync(preflightWebFile)) unlinkSync(preflightWebFile);
} catch {
  try { if (existsSync(preflightWebFile)) unlinkSync(preflightWebFile); } catch {}
  try { restoreWebEnv(); } catch {
    throw new Error('Compose preflight failed; prior web environment could not be restored.');
  }
  throw new Error('Compose preflight or cleanup failed; deployment stopped before queue drain.');
}
const queuePrefix = 'import {Queue} from "bullmq";import {makeRedis} from "./dist/src/queue/runtime.js";import {collectQueue,refreshQueue,discoverQueue} from "./dist/src/queue/queues.js";const dailyQueue=new Queue("collect-daily-sites",{connection:makeRedis()});const queues=[collectQueue,refreshQueue,discoverQueue,dailyQueue];';
const queues = code => docker(['exec', 'radar-worker', 'node', '--input-type=module', '-e', queuePrefix + code + ';process.exit(0)'], true);
let pausedBefore;
let activationStarted = false;
try {
  pausedBefore = JSON.parse(queues('console.log(JSON.stringify(await Promise.all(queues.map(q=>q.isPaused()))))'));
  queues('for(const q of queues)await q.pause()');
  for (let i = 0; i < 360; i++) {
    const active = JSON.parse(queues('console.log(JSON.stringify(await Promise.all(queues.map(q=>q.getActiveCount()))))'));
    if (active.every(n => n === 0)) break;
    if (i === 359) throw Error('Worker did not drain within 12 minutes');
    await wait(2000);
  }
  // Archive logs before container replacement, preserving previous minute summaries.
  writeFileSync(join(release, 'web-before.log'), docker(['logs', 'radar-stack-m9wohj-web-1'], true), { mode: 0o600 });
  activationStarted = true;
  writeFileSync(webFile, nextWeb); writeFileSync(workerFile, nextWorker);
  compose('radar-stack-m9wohj', webFile, 'web');
  try { await health('radar-stack-m9wohj-web-1'); }
  catch (err) {
    try { console.error('=== PROMOTED WEB LOGS ===\n' + docker(['logs', '--tail', '100', 'radar-stack-m9wohj-web-1'], true)); } catch {}
    throw err;
  }
  compose('radar-workers', workerFile, 'worker'); await health('radar-worker');
  for (const name of ['radar-stack-m9wohj-web-1', 'radar-worker']) {
    if (inspect(name).Config.Labels['org.opencontainers.image.revision'] !== revision) throw Error('Running revision differs from main');
  }
  writeFileSync(join(release, 'deployment.json'), JSON.stringify({ revision, webId, workerId, deployedAt: new Date().toISOString(), healthy: true }, null, 2));
  console.log(`Published main ${revision}; web and worker healthy`);
} catch (error) {
  restoreWebEnv();
  if (activationStarted) {
    writeFileSync(webFile, beforeWeb); writeFileSync(workerFile, beforeWorker);
    compose('radar-stack-m9wohj', webFile, 'web'); compose('radar-workers', workerFile, 'worker');
  }
  throw error;
} finally {
  if (pausedBefore) queues(`const before=${JSON.stringify(pausedBefore)};for(let i=0;i<queues.length;i++)if(!before[i])await queues[i].resume()`);
}
