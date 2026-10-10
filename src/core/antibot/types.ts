export type Mode = 'off' | 'shadow' | 'enforce';
export type PolicyId =
  | 'search' | 'detail' | 'mapa' | 'vitrine' | 'cadastro' | 'espera' | 'login'
  | 'wsIp' | 'wsAccount' | 'write';
export type Subject = { type: 'ip'; value: string } | { type: 'account'; id: number };
export type DecisionReason = 'allowed' | 'quota' | 'capacity' | 'degraded_budget';
export type DecisionSource = 'redis' | 'fallback' | 'off';

export interface Decision {
  allowed: boolean;
  wouldBlock: boolean;
  reason: DecisionReason;
  source: DecisionSource;
  retryAfterSeconds: number;
}

export interface Policy {
  readonly id: PolicyId;
  readonly identity: Subject['type'];
  readonly max: number;
  readonly windowMs: number;
}

export interface AntibotConfig {
  readonly mode: Mode;
  readonly environment: string;
  readonly redisUrl: string;
  readonly policies: Readonly<Record<PolicyId, Policy>>;
}

export type AntibotEvent =
  | { type: 'degraded'; reason: 'redis_error'; mode: Mode }
  | { type: 'recovered'; mode: Mode }
  | { type: 'error'; area: 'redis' | 'recovery'; mode: Mode }
  | { type: 'denied'; policy: PolicyId; reason: Exclude<DecisionReason, 'allowed'>; source: Exclude<DecisionSource, 'off'>; mode: Mode }
  | { type: 'saturated'; area: 'subjects' | 'budget' | 'leases'; mode: Mode };

export type AntibotObserver = (event: AntibotEvent) => void;
export type MonotonicClock = () => number;

/** Adapter seam around @fastify/rate-limit's official RedisStore. */
export interface RateLimitDriver {
  check(policy: Policy, key: string): Promise<{ allowed: boolean; ttlMs: number }>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface CheckOptions {
  clock?: MonotonicClock;
  observer?: AntibotObserver;
  driver?: RateLimitDriver;
}
