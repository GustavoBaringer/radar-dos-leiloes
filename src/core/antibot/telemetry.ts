import type { AntibotEvent, AntibotObserver, Mode, PolicyId } from './types.js';
import type { ChallengeAction } from './challenge.js';

const MAX_SERIES = 512;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const MODES: readonly Mode[] = ['off', 'shadow', 'enforce'];
const POLICIES: readonly PolicyId[] = ['search', 'detail', 'mapa', 'vitrine', 'cadastro', 'espera', 'login', 'image', 'imageMiss', 'wsIp', 'wsAccount', 'write'];
const CHALLENGE_ACTIONS: readonly ChallengeAction[] = ['login', 'cadastro', 'espera'];
const WS_EVENTS = ['quota', 'redis_unavailable', 'lease_lost', 'capacity'] as const;
const WS_OUTCOMES = ['would_deny', 'denied', 'allowed'] as const;
const durationBuckets = ['lt50ms', '50_199ms', '200_999ms', '1000_2999ms', 'ge3000ms'] as const;

export interface OperationsTelemetryOptions {
  antibotMode: Mode;
  challengeMode: 'off' | 'enforce';
  proxyTrustConfigured: boolean;
}

export function createOperationsTelemetry(options: OperationsTelemetryOptions) {
  const counters = new Map<string, number>();
  let degradedObserved = false;

  const increment = (label: string) => {
    if (counters.size >= MAX_SERIES && !counters.has(label)) return;
    const current = counters.get(label) ?? 0;
    counters.set(label, current >= MAX_COUNT ? MAX_COUNT : current + 1);
  };

  function observeAntibot(event: AntibotEvent): void {
    try {
      switch (event.type) {
        case 'degraded':
          if (!MODES.includes(event.mode)) return;
          degradedObserved = true;
          increment(`foundation.degraded.${event.mode}`);
          break;
        case 'recovered':
          if (!MODES.includes(event.mode)) return;
          degradedObserved = false;
          increment(`foundation.recovered.${event.mode}`);
          break;
        case 'error':
          if (!MODES.includes(event.mode) || !['redis', 'recovery'].includes(event.area)) return;
          increment(`foundation.error.${event.mode}.${event.area}`);
          break;
        case 'denied':
          if (!MODES.includes(event.mode) || !POLICIES.includes(event.policy) || !['quota', 'capacity', 'degraded_budget'].includes(event.reason) || !['redis', 'fallback'].includes(event.source)) return;
          increment(`foundation.denied.${event.mode}.${event.policy}.${event.reason}.${event.source}`);
          break;
        case 'saturated':
          if (!MODES.includes(event.mode) || !['subjects', 'budget', 'leases'].includes(event.area)) return;
          increment(`foundation.saturated.${event.mode}.${event.area}`);
          break;
      }
    } catch { /* telemetry is never on the decision path */ }
  }

  function observeWs(event: typeof WS_EVENTS[number], outcome: typeof WS_OUTCOMES[number]): void {
    try {
      if (!WS_EVENTS.includes(event) || !WS_OUTCOMES.includes(outcome)) return;
      increment(`ws.sample.${event}.${outcome}`);
    } catch { /* event callback must remain non-throwing */ }
  }

  function observeChallenge(action: ChallengeAction, outcome: 'success' | 'invalid' | 'unavailable' | 'error', durationMs: number): void {
    try {
      if (!CHALLENGE_ACTIONS.includes(action) || !['success', 'invalid', 'unavailable', 'error'].includes(outcome)) return;
      const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
      const bucket = duration < 50 ? durationBuckets[0] : duration < 200 ? durationBuckets[1] : duration < 1000 ? durationBuckets[2] : duration < 3000 ? durationBuckets[3] : durationBuckets[4];
      increment(`challenge.${action}.${outcome}.${bucket}`);
    } catch { /* observer cannot affect challenge decisions */ }
  }

  function snapshot() {
    return {
      modes: {
        antibot: options.antibotMode,
        challenge: options.challengeMode,
        proxyTrust: options.proxyTrustConfigured ? 'configured' : 'disabled',
      },
      degraded: { observed: degradedObserved },
      counters: [...counters].map(([series, count]) => ({ series, count })),
    };
  }

  return { observeAntibot, observeWs, observeChallenge, snapshot };
}

/** Telemetry composes with the pre-existing bounded logger; neither can throw into requests. */
export function composeOperationsObserver(telemetry: Pick<ReturnType<typeof createOperationsTelemetry>, 'observeAntibot'>, logger: AntibotObserver): AntibotObserver {
  return (event) => {
    try { telemetry.observeAntibot(event); } catch { /* keep logger and request path intact */ }
    try { logger(event); } catch { /* preserve policy decision regardless of observability */ }
  };
}
