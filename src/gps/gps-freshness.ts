/**
 * Position freshness — the single rule that decides whether a GPS fix still describes
 * the vehicle NOW, or is merely the last thing we ever heard.
 *
 * This exists because "the provider returned the vehicle in this poll" and "the vehicle
 * reported a new GPS fix" are different facts, and the sync used to conflate them:
 * every poll wrote `lastSeenAt = new Date()`, so a vehicle whose last real fix was 40
 * minutes old still looked live, and its 40-minute-old speed was displayed as current.
 *
 * Freshness is therefore measured from the PROVIDER's fix timestamp, never from our
 * poll time.
 */

/** Clock skew tolerated before a fix is treated as future-dated garbage. */
const FUTURE_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

/** Floor for the staleness window, so a fast poller can't mark vehicles offline on a blip. */
const MIN_STALENESS_MS = 5 * 60 * 1000;

/** How many consecutive polls a vehicle may miss before its position is stale. */
const MISSED_POLLS_BEFORE_STALE = 4;

/**
 * Staleness window for one provider, derived from that provider's own poll cadence
 * rather than a single global constant — the two providers differ by 5x.
 *
 * Measured in production 2026-08-14:
 *   AiroTrack  pollIntervalSec=60   fix age: median 2.8 min   -> window 5 min
 *   Transight  pollIntervalSec=300  fix age: median 10.2 min  -> window 20 min
 *
 * Transight's own devices report roughly every 10 minutes, so a 5-minute window would
 * flap half the fleet between ONLINE and OFFLINE on every tick. 4 missed polls sits
 * comfortably above the observed p90 for both providers while still catching the real
 * failures (production currently has fixes 44 min, 157 min and 28 days old).
 */
export function stalenessThresholdMs(
  pollIntervalSec: number | null | undefined,
): number {
  const poll = (pollIntervalSec ?? 300) * 1000;
  return Math.max(poll * MISSED_POLLS_BEFORE_STALE, MIN_STALENESS_MS);
}

/**
 * Age of a fix in ms, or null when the timestamp is missing or unusable.
 *
 * A fix dated further into the future than the skew tolerance is rejected (null) rather
 * than treated as brand new — that is exactly the failure the Transight timezone bug
 * produced, where every position looked 5.5 hours "fresh" and nothing could ever be
 * stale.
 */
export function positionAgeMs(
  fixTime: Date | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!fixTime) return null;
  const t = fixTime.getTime();
  if (!Number.isFinite(t)) return null;

  const age = now - t;
  if (age < -FUTURE_SKEW_TOLERANCE_MS) return null;

  return Math.max(0, age);
}

/**
 * True when this fix is recent enough to describe the vehicle's current state.
 *
 * A missing timestamp is NOT silently treated as fresh here; callers decide, because
 * the right fallback differs (the sync trusts its own poll time when a provider sends
 * no timestamp at all, the offline sweep does not).
 */
export function isPositionFresh(
  fixTime: Date | null | undefined,
  pollIntervalSec: number | null | undefined,
  now: number = Date.now(),
): boolean {
  const age = positionAgeMs(fixTime, now);
  if (age === null) return false;
  return age <= stalenessThresholdMs(pollIntervalSec);
}
