/**
 * ETA alert classification (ETA-06.1) — pure. Turns the existing read-only ETA
 * (trip-eta.util) and delay (trip-delay.util, ETA-05.1) signals into raisable
 * "alerts": a DELAY alert when a trip runs past schedule, and an ETA_SHIFT alert
 * when the live ETA has moved significantly from a known baseline. No persistence,
 * no notification dispatch, no external calls — delivering alerts to users is the
 * (not-yet-built) Notification module's job.
 */
import { DelayResult } from './trip-delay.util';

/** Minutes the live ETA must move from a baseline before it's a significant shift. */
export const DEFAULT_ETA_SHIFT_ALERT_MINUTES = 15;

/** Delay at/above this many minutes past schedule escalates to CRITICAL. */
export const DELAY_ALERT_CRITICAL_MINUTES = 30;

export type EtaAlertType = 'DELAY' | 'ETA_SHIFT';
export type EtaAlertSeverity = 'WARNING' | 'CRITICAL';

export interface EtaAlert {
  type: EtaAlertType;
  severity: EtaAlertSeverity;
  /** Magnitude in minutes (delay past schedule, or size of the ETA shift). */
  minutes: number;
  message: string;
}

/** DELAY alert from an ETA-05.1 delay result, or null when the trip is on time. */
export function buildDelayAlert(
  delay: DelayResult,
  criticalMinutes: number = DELAY_ALERT_CRITICAL_MINUTES,
): EtaAlert | null {
  if (!delay.isDelayed) return null;

  return {
    type: 'DELAY',
    severity: delay.delayMinutes >= criticalMinutes ? 'CRITICAL' : 'WARNING',
    minutes: delay.delayMinutes,
    message: `Running ${delay.delayMinutes} min past scheduled arrival`,
  };
}

/**
 * ETA_SHIFT alert when the live ETA has drifted from a baseline by more than the
 * threshold, or null when the movement is within tolerance.
 */
export function buildEtaShiftAlert(
  baselineEta: Date,
  currentEta: Date,
  thresholdMinutes: number = DEFAULT_ETA_SHIFT_ALERT_MINUTES,
): EtaAlert | null {
  const shiftMinutes = Math.round(
    (currentEta.getTime() - baselineEta.getTime()) / 60000,
  );
  const magnitude = Math.abs(shiftMinutes);
  if (magnitude < thresholdMinutes) return null;

  return {
    type: 'ETA_SHIFT',
    severity: magnitude >= thresholdMinutes * 2 ? 'CRITICAL' : 'WARNING',
    minutes: magnitude,
    message: `ETA moved ${magnitude} min ${shiftMinutes > 0 ? 'later' : 'earlier'}`,
  };
}
