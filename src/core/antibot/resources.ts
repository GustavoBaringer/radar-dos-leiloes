/**
 * DECISÃO TEMPORÁRIA — 2026-10-12, dono do projeto.
 *
 * O proxy de imagens (`GET /api/img`) fica SEM limite de requisições: nem cota
 * por minuto (já removida em c6dd64d, que tirou as políticas `image` e
 * `imageMiss`) nem teto de concorrência. `tryAcquireImageJob()` virou uma lease
 * sem contagem e `runMiss()` em `images.ts` parou de competir pelo orçamento de
 * quatro leituras, que segue valendo — e só importa — para as demais rotas.
 *
 * Continua valendo no proxy: allowlist de hosts, validação de raster, 20 MiB de
 * download, prazo de 15 s, cache em memória limitado e `acquireDegradedWork()`
 * (que só corta em `ANTIBOT_MODE=enforce` com o Redis degradado). Ou seja, não
 * existe mais caminho que devolva 503/429 *por quantidade de imagens*.
 *
 * Risco assumido: sem backpressure, muitas fotos simultâneas rodam sharp em
 * paralelo e podem saturar CPU/memória do container web. Medir `images` em
 * `/api/security/metrics` antes de isto virar decisão permanente.
 *
 * Como reverter: restaurar `IMAGE_LIMIT = 2` com o semáforo em
 * `createResourcePool`/`tryAcquireImageJob`, a aquisição de `tryAcquireResource`
 * em `runMiss()` (`images.ts`) e o limite 2 de `createImageQueue`
 * (`app-busca/src/lib/image-queue.ts`).
 */
export interface ResourceLease {
  release(): void;
}

export interface ResourcePool {
  /** Shared process-local cap for expensive reads: four by default, no queue. */
  tryAcquireResource(): ResourceLease | null;
  /** Sem teto por decisão temporária: concede sempre, e liberar é no-op. */
  tryAcquireImageJob(): ResourceLease | null;
}

export interface ResourcePoolOptions {
  maxResources?: number;
}

const READ_LIMIT = 4;

function semaphore(limit: number) {
  let active = 0;
  return () => {
    if (active >= limit) return null;
    active++;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active--;
      },
    } satisfies ResourceLease;
  };
}

function limit(value: number | undefined, fallback: number, max: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) {
    throw new Error(`${name} deve ser inteiro entre 1 e ${max}`);
  }
  return selected;
}

/** Lease sem teto: `release()` pode ser chamada quantas vezes for, sem efeito. */
function unlimitedLease(): ResourceLease {
  return { release() {} };
}

export function createResourcePool(options: ResourcePoolOptions = {}): ResourcePool {
  const read = semaphore(limit(options.maxResources, READ_LIMIT, READ_LIMIT, 'maxResources'));
  return { tryAcquireResource: read, tryAcquireImageJob: unlimitedLease };
}

const shared = createResourcePool();

/** Shared default used by phase-2 server integration. */
export const tryAcquireResource = (): ResourceLease | null => shared.tryAcquireResource();
export const tryAcquireImageJob = (): ResourceLease | null => shared.tryAcquireImageJob();
