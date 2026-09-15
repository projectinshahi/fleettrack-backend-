/**
 * Destination ETA maths (ETA-01.1) — pure, derived entirely from the existing
 * route-progress `remainingMeters` plus an effective speed. No external services
 * or Maps travel time: speed is the live vehicle speed when it's actually moving,
 * else a constant average. Sibling to trip-progress.util.ts.
 */

/** Fallback cruising speed when there's no usable live speed (km/h). */
export const DEFAULT_AVG_SPEED_KMH = 40;

/** Below this the vehicle is treated as stopped/idle, so we use the average. */
const MIN_LIVE_SPEED_KMH = 5;

export interface EtaResult {
  /** Seconds from `now` until the destination is reached. */
  etaSeconds: number;
  /** Absolute arrival time (ISO 8601). */
  etaTimestamp: string;
  /** The speed the estimate was based on (km/h). */
  basisSpeedKmh: number;
}

/** The speed the ETA is based on: live speed when moving, else the average. */
export function effectiveSpeedKmh(liveSpeedKmh?: number | null): number {
  return typeof liveSpeedKmh === 'number' && liveSpeedKmh > MIN_LIVE_SPEED_KMH
    ? liveSpeedKmh
    : DEFAULT_AVG_SPEED_KMH;
}

/**
 * Compute the destination ETA from remaining distance and (optional) live speed.
 * Callers guard for an active trip with a live position and remaining > 0.
 */
export function computeEta(
  remainingMeters: number,
  liveSpeedKmh: number | null | undefined,
  now: Date,
): EtaResult {
  const basisSpeedKmh = effectiveSpeedKmh(liveSpeedKmh);
  const metersPerSecond = (basisSpeedKmh * 1000) / 3600;
  const etaSeconds = Math.round(remainingMeters / metersPerSecond);

  return {
    etaSeconds,
    etaTimestamp: new Date(now.getTime() + etaSeconds * 1000).toISOString(),
    basisSpeedKmh,
  };
}
