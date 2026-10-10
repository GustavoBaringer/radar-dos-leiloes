/** Deployment controls; defaults preserve the original worker behavior. */
export function workerDeployment(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  };
  const flag = (name: string, fallback = true) => {
    if (env[name] === undefined) return fallback;
    if (env[name] !== '0' && env[name] !== '1') throw new Error(`Invalid ${name}`);
    return env[name] === '1';
  };
  const timezone = env.WORKER_TIMEZONE ?? 'UTC';
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  const sourceMap = (name: string, minimum: number, maximum: number): Record<string, number> => {
    const value: unknown = JSON.parse(env[name] ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`);
    for (const [key, setting] of Object.entries(value)) {
      if (!/^[a-z0-9_-]+$/.test(key) || !Number.isInteger(setting) || Number(setting) < minimum || Number(setting) > maximum) throw new Error(`Invalid ${name}`);
    }
    return value as Record<string, number>;
  };
  return {
    timezone,
    concurrency: integer('WORKER_COLLECT_CONCURRENCY', 2, 1, 2),
    jobTimeoutMs: integer('WORKER_JOB_TIMEOUT_MS', 180000, 1000, 600000),
    sourceLimits: sourceMap('WORKER_SOURCE_LIMITS', 1, 15000),
    sourceTimeouts: sourceMap('WORKER_SOURCE_TIMEOUTS_MS', 1000, 600000),
    apiLimit: integer('WORKER_API_LIMIT', 15000, 1, 15000),
    htmlLimit: integer('WORKER_HTML_LIMIT', 1200, 1, 1200),
    discoveryLimit: integer('WORKER_DISCOVERY_LIMIT', 150, 1, 150),
    discoveryConcurrency: integer('WORKER_DISCOVERY_CONCURRENCY', 12, 1, 12),
    verifyLimit: integer('VERIFICAR_POR_CICLO', 300, 1, 300),
    stagger: flag('WORKER_STAGGER', false),
    serial: flag('WORKER_SERIAL_COLLECTIONS', false),
    refresh: flag('WORKER_REFRESH_ENABLED'),
    discover: flag('WORKER_DISCOVER_ENABLED'),
    close: flag('WORKER_CLOSE_ENABLED'),
    verify: flag('WORKER_VERIFY_ENABLED'),
    sources: env.WORKER_SOURCES ? new Set(env.WORKER_SOURCES.split(',').map(x => x.trim()).filter(Boolean)) : null,
  };
}

export function boundedCollection(settings: ReturnType<typeof workerDeployment>, sourceId: string, method: string, requested: number) {
  if (!Number.isInteger(requested) || requested < 1) throw new Error('Invalid collection limit');
  const cap = method === 'api' ? settings.apiLimit : settings.htmlLimit;
  return { limit: Math.min(requested, cap, settings.sourceLimits[sourceId] ?? cap), timeoutMs: settings.sourceTimeouts[sourceId] ?? settings.jobTimeoutMs };
}

/** A shared gate prevents collect and refresh from launching two browsers together. */
export function createCollectionGate() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => undefined);
    return next;
  };
}
