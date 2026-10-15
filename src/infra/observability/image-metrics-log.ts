import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Daily aggregate files survive container replacement. No request identifiers. */
export function createImageMetricsLog(directory: string | undefined) {
  let pending = Promise.resolve();
  let lastDay = '';
  return {
    write(summary: { minuteUtc: string } & Record<string, unknown>) {
      if (!directory) return;
      pending = pending.then(async () => {
        const day = summary.minuteUtc.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid image metrics day');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (lastDay !== day) {
          const cutoff = new Date(Date.parse(day) - 90 * 86_400_000).toISOString().slice(0, 10);
          for (const file of await readdir(directory)) {
            if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) await unlink(join(directory, file));
          }
          lastDay = day;
        }
        await appendFile(join(directory, `${day}.jsonl`), JSON.stringify(summary) + '\n', { mode: 0o600 });
      }).catch(() => { console.warn('[images.metrics] Não foi possível persistir o resumo por minuto'); });
    },
    close: () => pending,
  };
}
