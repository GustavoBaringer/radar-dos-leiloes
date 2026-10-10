import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chownSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run through flock from Dokploy; builds both services before touching live containers.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.RADAR_RUNTIME_DIR ?? '/etc/dokploy/radar-runtime/059af2b';
const docker = (args, quiet = false) => execFileSync('docker', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
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
const liveWeb = inspect('radar-stack-m9wohj-web-1');
const envFile = join(release, 'candidate.env');
const candidate = `radar-candidate-${revision.slice(0, 12)}`;
// Secret environment exists only in a private temporary file; never echo it.
writeFileSync(envFile, liveWeb.Config.Env.filter(e => !e.startsWith('IMAGE_METRICS_DIR=')).join('\n') + '\nIMAGE_METRICS_DIR=/tmp/image-metrics\n', { mode: 0o600 });
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
const nextWorker = beforeWorker.replace(/(\n    image:) [^\n]+/, `$1 ${workerId}`);
if (!nextWorker.includes(`image: ${workerId}`)) throw Error('Worker image replacement failed');
const queuePrefix = 'import {collectQueue,refreshQueue,discoverQueue} from "./dist/src/queue/queues.js";const queues=[collectQueue,refreshQueue,discoverQueue];';
const queues = code => docker(['exec', 'radar-worker', 'node', '--input-type=module', '-e', queuePrefix + code + ';process.exit(0)'], true);
const pausedBefore = JSON.parse(queues('console.log(JSON.stringify(await Promise.all(queues.map(q=>q.isPaused()))))'));
let activationStarted = false;
try {
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
  for (const file of [webFile, workerFile]) docker(['compose', '--env-file', join(runtime, 'production.env'), '-f', file, 'config', '--quiet']);
  compose('radar-stack-m9wohj', webFile, 'web'); await health('radar-stack-m9wohj-web-1');
  compose('radar-workers', workerFile, 'worker'); await health('radar-worker');
  for (const name of ['radar-stack-m9wohj-web-1', 'radar-worker']) {
    if (inspect(name).Config.Labels['org.opencontainers.image.revision'] !== revision) throw Error('Running revision differs from main');
  }
  writeFileSync(join(release, 'deployment.json'), JSON.stringify({ revision, webId, workerId, deployedAt: new Date().toISOString(), healthy: true }, null, 2));
  console.log(`Published main ${revision}; web and worker healthy`);
} catch (error) {
  if (activationStarted) {
    writeFileSync(webFile, beforeWeb); writeFileSync(workerFile, beforeWorker);
    compose('radar-stack-m9wohj', webFile, 'web'); compose('radar-workers', workerFile, 'worker');
  }
  throw error;
} finally {
  queues(`const before=${JSON.stringify(pausedBefore)};for(let i=0;i<queues.length;i++)if(!before[i])await queues[i].resume()`);
}
