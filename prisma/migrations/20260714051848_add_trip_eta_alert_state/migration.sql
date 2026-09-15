-- ETA-06.1: persisted, per-trip ETA-monitor state (additive, nullable).
-- etaDelayAlertedAt: set while an ETA-predicted delay episode is active (dedup).
-- etaBaseline: last accepted ETA; a significant drift re-baselines + alerts.
ALTER TABLE "Trip" ADD COLUMN "etaDelayAlertedAt" TIMESTAMP(3),
ADD COLUMN "etaBaseline" TIMESTAMP(3);
