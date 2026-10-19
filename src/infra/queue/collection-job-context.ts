export function collectionJobContext(job: { id?: string } | undefined, origin: 'cron' | 'refresh') {
  const jobId = job?.id;
  const match = jobId?.match(/^repeat:.*:(\d{13})$/);
  const timestamp = match ? Number(match[1]) : NaN;
  const scheduledAt = Number.isSafeInteger(timestamp) && Number.isFinite(new Date(timestamp).getTime())
    ? new Date(timestamp)
    : undefined;
  return { origin, ...(jobId ? { jobId } : {}), ...(scheduledAt ? { scheduledAt } : {}) };
}
