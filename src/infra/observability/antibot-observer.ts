import type { AntibotEvent, AntibotObserver } from '../../domain/security/antibot.types.js';

const DEFAULT_LOGS_PER_LABEL = 10;
const DEFAULT_LOG_WINDOW_MS = 60_000;

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
