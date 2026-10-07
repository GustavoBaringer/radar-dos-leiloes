import { normalizeClientIp } from './ip.js';
import type {
  AntibotConfig, AntibotEvent, AntibotObserver, CheckOptions, Decision, Policy,
  PolicyId, RateLimitDriver, Subject,
} from './types.js';

const FALLBACK_CAPACITY = 1024;
const FALLBACK_ADMISSIONS = 60;
const FALLBACK_BUDGET_MS = 60_000;
const DEGRADED_LEASES = 2;
const FALLBACK_CAPACITY_PER_POLICY = 1024;
const DEFAULT_LOGS_PER_LABEL = 10;
const DEFAULT_LOG_WINDOW_MS = 60_000;

interface Counter { count: number; expiresAt: number; }
interface AdmissionBudget { count: number; expiresAt: number; }

export interface Antibot {
  check(policyId: PolicyId, subject: Subject): Promise<Decision>;
  /** No-op lease while healthy/off/shadow; null only when enforce denies degraded capacity. */
  acquireDegradedWork(): { release(): void } | null;
  close(): Promise<void>;
}

export interface CreateAntibotOptions extends CheckOptions {
  config: AntibotConfig;
}

function labelFor(event: AntibotEvent): string {
  switch (event.type) {
    case 'degraded': return `degraded:${event.mode}`;
    case 'recovered': return `recovered:${event.mode}`;
    case 'error': return `error:${event.mode}:${event.area}`;
    case 'denied': return `denied:${event.mode}:${event.policy}:${event.reason}:${event.source}`;
    case 'saturated': return `saturated:${event.mode}:${event.area}`;
  }
}

export function createDefaultObserver(now: () => number = () => performance.now()): AntibotObserver {
  const buckets = new Map<string, { start: number; emitted: number; suppressed: number }>();
  const log = (label: string, suppressed = 0) => console.warn('[antibot]', JSON.stringify({ label, suppressed }));
  return (event) => {
    const label = labelFor(event);
    const time = now();
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = { start: time, emitted: 0, suppressed: 0 };
      buckets.set(label, bucket);
    } else if (time >= bucket.start + DEFAULT_LOG_WINDOW_MS) {
      const suppressed = bucket.suppressed;
      bucket.start = time;
      bucket.emitted = 0;
      bucket.suppressed = 0;
      if (suppressed > 0) {
        log(label, suppressed);
        bucket.emitted++;
      }
    }
    if (bucket.emitted >= DEFAULT_LOGS_PER_LABEL) {
      bucket.suppressed = Math.min(Number.MAX_SAFE_INTEGER, bucket.suppressed + 1);
      return;
    }
    log(label);
    bucket.emitted++;
  };
}

const NOOP_LEASE = Object.freeze({ release() {} });

const retrySeconds = (ttlMs: number): number => Math.max(1, Math.ceil(Math.max(0, ttlMs) / 1000));

function validateSubject(policy: Policy, subject: Subject): Subject {
  if (subject.type !== policy.identity) throw new Error(`policy ${policy.id} exige identidade ${policy.identity}`);
  if (subject.type === 'account') {
    if (!Number.isSafeInteger(subject.id) || subject.id <= 0) throw new Error('account subject deve ter id inteiro positivo');
    return { type: 'account', id: subject.id };
  }
  return { type: 'ip', value: normalizeClientIp(subject.value) };
}

export function createAntibot(options: CreateAntibotOptions): Antibot {
  const { config } = options;
  const now = options.clock ?? (() => performance.now());
  const observer = options.observer ?? (config.mode === 'off' ? () => {} : createDefaultObserver(now));
  const driver: RateLimitDriver | undefined = options.driver;
  if (config.mode !== 'off' && !driver) throw new Error('modo antibot ativo exige RateLimitDriver');
  const counters = new Map<PolicyId, Map<string, Counter>>();
  const maxWindow = Math.max(...Object.values(config.policies).map((p) => p.windowMs));
  let degradedUntil = 0;
  let recoveryLastAttempt = Number.NEGATIVE_INFINITY;
  let recoveryFlight: Promise<void> | null = null;
  let admissionBudget: AdmissionBudget | null = null;
  let activeLeases = 0;
  let closed = false;

  const emit = (event: AntibotEvent) => {
    try { observer(event); } catch { /* observability must not fail the request */ }
  };
  const publicDecision = (policyId: PolicyId, allowed: boolean, wouldBlock: boolean, reason: Decision['reason'], source: Decision['source'], ttlMs: number): Decision => {
    const result = { allowed, wouldBlock, reason, source, retryAfterSeconds: allowed ? 0 : retrySeconds(ttlMs) };
    if (wouldBlock && source !== 'off' && reason !== 'allowed') {
      emit({ type: 'denied', policy: policyId, reason, source, mode: config.mode });
    }
    return result;
  };

  const redisKey = (policy: Policy, subject: Subject) =>
    JSON.stringify([policy.id, subject.type, subject.type === 'ip' ? subject.value : subject.id]);

  const enterDegraded = () => {
    const first = degradedUntil === 0;
    degradedUntil = now() + maxWindow;
    if (first) emit({ type: 'degraded', reason: 'redis_error', mode: config.mode });
  };

  const attemptRecovery = () => {
    if (!driver || recoveryFlight || now() - recoveryLastAttempt < 1_000) return;
    recoveryLastAttempt = now();
    recoveryFlight = Promise.resolve().then(() => driver.ping()).then(() => {
      if (degradedUntil > 0) emit({ type: 'recovered', mode: config.mode });
      degradedUntil = 0;
    }).catch(() => {
      emit({ type: 'error', area: 'recovery', mode: config.mode });
      degradedUntil = now() + 1_000;
    }).finally(() => { recoveryFlight = null; });
  };

  const fallbackCheck = (policy: Policy, key: string): Decision => {
    const time = now();
    let policyCounters = counters.get(policy.id);
    if (!policyCounters) {
      policyCounters = new Map();
      counters.set(policy.id, policyCounters);
    }
    for (const [counterKey, entry] of policyCounters) {
      if (time >= entry.expiresAt) policyCounters.delete(counterKey);
    }
    let entry = policyCounters.get(key);
    if (!entry) {
      if (policyCounters.size >= FALLBACK_CAPACITY_PER_POLICY) {
        emit({ type: 'saturated', area: 'subjects', mode: config.mode });
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const current of policyCounters.values()) nextExpiry = Math.min(nextExpiry, current.expiresAt);
        return publicDecision(policy.id, config.mode !== 'enforce', true, 'capacity', 'fallback', nextExpiry - time);
      }
      entry = { count: 0, expiresAt: time + policy.windowMs };
      policyCounters.set(key, entry);
    }
    entry.count++;
    const ttl = entry.expiresAt - time;
    const quotaAllowed = entry.count <= policy.max;
    if (!quotaAllowed) return publicDecision(policy.id, config.mode !== 'enforce', true, 'quota', 'fallback', ttl);

    if (!admissionBudget || time >= admissionBudget.expiresAt) admissionBudget = { count: 0, expiresAt: time + FALLBACK_BUDGET_MS };
    if (admissionBudget.count >= FALLBACK_ADMISSIONS) {
      emit({ type: 'saturated', area: 'budget', mode: config.mode });
      return publicDecision(policy.id, config.mode !== 'enforce', true, 'degraded_budget', 'fallback', admissionBudget.expiresAt - time);
    }
    admissionBudget.count++;
    return publicDecision(policy.id, true, false, 'allowed', 'fallback', ttl);
  };

  async function check(policyId: PolicyId, input: Subject): Promise<Decision> {
    if (closed) throw new Error('antibot fechado');
    const policy = config.policies[policyId];
    if (!policy) throw new Error(`policy desconhecida: ${policyId}`);
    const subject = validateSubject(policy, input);
    if (config.mode === 'off') return { allowed: true, wouldBlock: false, reason: 'allowed', source: 'off', retryAfterSeconds: 0 };
    const key = redisKey(policy, subject);
    if (degradedUntil > 0) {
      if (now() >= degradedUntil) attemptRecovery();
      return fallbackCheck(policy, key);
    }
    try {
      const result = await driver!.check(policy, key);
      const allowed = result.allowed;
      const wouldBlock = !allowed;
      return publicDecision(policyId, config.mode === 'shadow' || allowed, wouldBlock, wouldBlock ? 'quota' : 'allowed', 'redis', result.ttlMs);
    } catch {
      emit({ type: 'error', area: 'redis', mode: config.mode });
      enterDegraded();
      return fallbackCheck(policy, key);
    }
  }

  function acquireDegradedWork(): { release(): void } | null {
    if (config.mode !== 'enforce' || degradedUntil === 0) return NOOP_LEASE;
    if (activeLeases >= DEGRADED_LEASES) {
      emit({ type: 'saturated', area: 'leases', mode: config.mode });
      return null;
    }
    activeLeases++;
    let released = false;
    return { release() { if (!released) { released = true; activeLeases--; } } };
  }

  return {
    check,
    acquireDegradedWork,
    async close() {
      if (closed) return;
      closed = true;
      counters.clear();
      admissionBudget = null;
      await driver?.close();
    },
  };
}
