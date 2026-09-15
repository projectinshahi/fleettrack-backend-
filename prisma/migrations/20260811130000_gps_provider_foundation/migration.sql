-- GPS provider foundation: global vehicle inventory + backend-only provider config.
-- Verified against live data before authoring: 0 (providerName, providerVehicleId)
-- duplicates, all 15 vehicles have a providerVehicleId, so the unique index is safe.
-- Run scripts/check-provider-duplicates.cjs again immediately before applying.

-- Vehicle.clientId becomes nullable: NULL = unassigned global inventory. Existing
-- values are preserved (only the NOT NULL constraint is dropped; the FK + its
-- ON DELETE CASCADE are unchanged).
ALTER TABLE "Vehicle" ALTER COLUMN "clientId" DROP NOT NULL;

-- Transight device identity.
ALTER TABLE "Vehicle" ADD COLUMN "imei" TEXT;

-- Provider identity uniqueness (NULLs are distinct in Postgres, so pre-provider rows
-- with NULL providerVehicleId do not collide).
CREATE UNIQUE INDEX "Vehicle_providerName_providerVehicleId_key"
  ON "Vehicle"("providerName", "providerVehicleId");

-- Backend-only GPS provider configuration.
CREATE TYPE "GpsProviderName" AS ENUM ('AIROTRACK', 'TRANSIGHT');

CREATE TABLE "GpsIntegration" (
    "id" TEXT NOT NULL,
    "provider" "GpsProviderName" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT NOT NULL,
    "system" TEXT,
    "credential" TEXT,
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 300,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GpsIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GpsIntegration_provider_key" ON "GpsIntegration"("provider");
