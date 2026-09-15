/**
 * Report date filters arrive from `<input type="date">` as calendar days ("2026-09-15").
 * `new Date("2026-09-15")` is UTC midnight, which is 05:30 in Asia/Kolkata, so a range read
 * that way started 5h30m late and ended 18h30m early: almost the whole "to" day fell outside
 * the report, and a single-day report returned nothing. A calendar day is read here as a
 * whole business day in the fixed business timezone (the same +05:30 the dashboard's weekly
 * activity buckets use); a full ISO timestamp is still honoured exactly as sent.
 */
const BUSINESS_UTC_OFFSET = '+05:30';
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive lower bound: 00:00:00.000 of that business day. */
export function reportRangeStart(from: string): Date {
  return CALENDAR_DAY.test(from)
    ? new Date(`${from}T00:00:00.000${BUSINESS_UTC_OFFSET}`)
    : new Date(from);
}

/** Inclusive upper bound: 23:59:59.999 of that business day. */
export function reportRangeEnd(to: string): Date {
  return CALENDAR_DAY.test(to)
    ? new Date(`${to}T23:59:59.999${BUSINESS_UTC_OFFSET}`)
    : new Date(to);
}
