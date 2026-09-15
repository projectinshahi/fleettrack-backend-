/**
 * Delay detection maths (ETA-05.1) — pure. A trip is flagged delayed when its
 * reference arrival (the predicted ETA for an active trip, else the current time
 * for a not-yet-active one) runs past `scheduledEnd` by more than a fixed margin.
 * The caller decides the reference arrival; this only compares. No status change,
 * no persistence, no external calls.
 */

/** Grace period past the planned end before a trip counts as delayed (minutes). */
export const DEFAULT_DELAY_MARGIN_MINUTES = 10;

export interface DelayResult {
  isDelayed: boolean;
  /** Minutes the reference arrival runs past scheduledEnd (0 when on time/early). */
  delayMinutes: number;
  marginMinutes: number;
  scheduledEnd: string;
  referenceArrival: string;
}

const MS_PER_MINUTE = 60000;

export function detectDelay(
  scheduledEnd: Date,
  referenceArrival: Date,
  marginMinutes: number = DEFAULT_DELAY_MARGIN_MINUTES,
): DelayResult {
  const lateMs = referenceArrival.getTime() - scheduledEnd.getTime();

  return {
    isDelayed: lateMs > marginMinutes * MS_PER_MINUTE,
    delayMinutes: Math.max(0, Math.round(lateMs / MS_PER_MINUTE)),
    marginMinutes,
    scheduledEnd: scheduledEnd.toISOString(),
    referenceArrival: referenceArrival.toISOString(),
  };
}
