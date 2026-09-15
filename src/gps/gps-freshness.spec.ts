import {
  isPositionFresh,
  positionAgeMs,
  stalenessThresholdMs,
} from './gps-freshness';

const MIN = 60_000;

// Real production cadences (GpsIntegration.pollIntervalSec) as of 2026-08-14.
const AIROTRACK_POLL = 60;
const TRANSIGHT_POLL = 300;

describe('stalenessThresholdMs', () => {
  it('gives each provider a window scaled to its own poll cadence', () => {
    // AiroTrack polls every minute; 4 missed polls is under the 5-min floor, so the
    // floor wins and a single slow tick can't flap the fleet offline.
    expect(stalenessThresholdMs(AIROTRACK_POLL)).toBe(5 * MIN);
    // Transight polls every 5 min and its devices report roughly every 10, so it needs
    // a materially larger window than AiroTrack — that's the whole point of per-provider.
    expect(stalenessThresholdMs(TRANSIGHT_POLL)).toBe(20 * MIN);
  });

  it('never drops below the floor, whatever the configured cadence', () => {
    expect(stalenessThresholdMs(1)).toBe(5 * MIN);
    expect(stalenessThresholdMs(0)).toBe(5 * MIN);
  });

  it('defaults to the conservative 5-minute cadence when unconfigured', () => {
    expect(stalenessThresholdMs(null)).toBe(20 * MIN);
    expect(stalenessThresholdMs(undefined)).toBe(20 * MIN);
  });
});

describe('positionAgeMs', () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0);

  it('measures age from the GPS fix time', () => {
    expect(positionAgeMs(new Date(now - 3 * MIN), now)).toBe(3 * MIN);
  });

  it('treats a small clock skew as "just now" rather than negative', () => {
    expect(positionAgeMs(new Date(now + 30_000), now)).toBe(0);
  });

  it('rejects a wildly future-dated fix instead of calling it fresh', () => {
    // This is the Transight timezone bug in miniature: +5:30 ahead of real UTC. If this
    // returned a negative age, every stale vehicle in the fleet would read as current.
    expect(positionAgeMs(new Date(now + 330 * MIN), now)).toBeNull();
  });

  it('returns null for a missing or unusable timestamp', () => {
    expect(positionAgeMs(null, now)).toBeNull();
    expect(positionAgeMs(undefined, now)).toBeNull();
    expect(positionAgeMs(new Date('nonsense'), now)).toBeNull();
  });
});

describe('isPositionFresh', () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0);

  it('accepts a fresh AiroTrack fix and rejects an aged one', () => {
    expect(isPositionFresh(new Date(now - 2 * MIN), AIROTRACK_POLL, now)).toBe(true);
    expect(isPositionFresh(new Date(now - 9 * MIN), AIROTRACK_POLL, now)).toBe(false);
  });

  it('still accepts a Transight fix that AiroTrack would already call stale', () => {
    // 10 min is Transight's observed median fix age — it must NOT read as offline.
    expect(isPositionFresh(new Date(now - 10 * MIN), TRANSIGHT_POLL, now)).toBe(true);
    expect(isPositionFresh(new Date(now - 10 * MIN), AIROTRACK_POLL, now)).toBe(false);
  });

  it('rejects the real stale positions seen in production', () => {
    // KL84D1077 (44 min) and KL84D1577 (157 min) were both displaying a live speed.
    expect(isPositionFresh(new Date(now - 44 * MIN), TRANSIGHT_POLL, now)).toBe(false);
    expect(isPositionFresh(new Date(now - 157 * MIN), TRANSIGHT_POLL, now)).toBe(false);
    // KL85B1418 — an AiroTrack device dead 28 days that rendered as MOVING at 13 km/h.
    expect(
      isPositionFresh(new Date(now - 28 * 24 * 60 * MIN), AIROTRACK_POLL, now),
    ).toBe(false);
  });

  it('is exclusive at the boundary in the safe direction', () => {
    expect(isPositionFresh(new Date(now - 20 * MIN), TRANSIGHT_POLL, now)).toBe(true);
    expect(isPositionFresh(new Date(now - 20 * MIN - 1), TRANSIGHT_POLL, now)).toBe(
      false,
    );
  });

  it('treats a missing timestamp as not-fresh (callers choose the fallback)', () => {
    expect(isPositionFresh(null, TRANSIGHT_POLL, now)).toBe(false);
  });
});
