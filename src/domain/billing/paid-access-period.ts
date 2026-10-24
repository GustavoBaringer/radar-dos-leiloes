const TIME_ZONE = 'America/Sao_Paulo';
const localDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export type PaidAccessPayment = { paymentId: string; confirmedDate: string };
export type PaidAccessPeriod = { paymentId: string; startsAt: Date; endsAt: Date };

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function utcMillis({ year, month, day, hour = 0, minute = 0, second = 0 }: LocalParts): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function partsAt(epochMs: number): LocalParts {
  const parts = Object.fromEntries(localDateTime.formatToParts(new Date(epochMs)).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function sameParts(a: LocalParts, b: LocalParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function saoPauloMidnight(year: number, month: number, day: number): Date {
  const wanted = { year, month, day, hour: 0, minute: 0, second: 0 };
  const wallClockAsUtc = utcMillis(wanted);
  let candidate = wallClockAsUtc;
  // Iterate the zone offset; reject skipped local midnight rather than shifting policy time.
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = partsAt(candidate);
    candidate = wallClockAsUtc - (utcMillis(local) - candidate);
    if (sameParts(partsAt(candidate), wanted)) return new Date(candidate);
  }
  throw new RangeError('Midnight does not exist in America/Sao_Paulo for this calendar date');
}

function parseConfirmedDate(value: string): { year: number; month: number; day: number; instant: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError('confirmedDate must be a canonical YYYY-MM-DD date');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) throw new RangeError('confirmedDate is not a calendar date');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new RangeError('confirmedDate is not a calendar date');
  }
  return { year, month, day, instant: saoPauloMidnight(year, month, day) };
}

function monthEndDay(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function nextMonthMidnight(start: Date): Date {
  const { year, month, day } = partsAt(start.getTime());
  const nextMonthIndex = year * 12 + month;
  const yearOfEnd = Math.floor(nextMonthIndex / 12);
  const monthOfEnd = nextMonthIndex % 12 + 1;
  const endDay = Math.min(day, monthEndDay(yearOfEnd, monthOfEnd));
  return saoPauloMidnight(yearOfEnd, monthOfEnd, endDay);
}

export function calculatePaidAccessPeriods(payments: readonly PaidAccessPayment[]): PaidAccessPeriod[] {
  if (!Array.isArray(payments)) throw new TypeError('payments must be an array');
  const seenIds = new Set<string>();
  const ordered = payments.map(payment => {
    if (!payment || typeof payment.paymentId !== 'string' || !payment.paymentId.trim()
      || payment.paymentId.length > 256 || /[\u0000-\u001f\u007f]/.test(payment.paymentId)) {
      throw new RangeError('paymentId must be a non-empty canonical identifier of at most 256 characters');
    }
    if (seenIds.has(payment.paymentId)) throw new RangeError('duplicate paymentId');
    seenIds.add(payment.paymentId);
    const confirmed = parseConfirmedDate(payment.confirmedDate);
    return { paymentId: payment.paymentId, confirmedDate: payment.confirmedDate, instant: confirmed.instant };
  }).sort((a, b) => a.confirmedDate < b.confirmedDate ? -1
    : a.confirmedDate > b.confirmedDate ? 1
      : a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : 0);

  let previousEnd = Number.NEGATIVE_INFINITY;
  return ordered.map(({ paymentId, instant }) => {
    const startsAt = new Date(Math.max(instant.getTime(), previousEnd));
    // Each renewal's next month is measured from its scheduled start (e.g. Feb 28 -> Mar 28).
    const endsAt = nextMonthMidnight(startsAt);
    previousEnd = endsAt.getTime();
    return { paymentId, startsAt, endsAt };
  });
}
