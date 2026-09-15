-- Trip Request + Admin Approval workflow (Slice 1).
--
-- 1. New notification types for the request lifecycle.
-- 2. Notification becomes audience-aware: clientId nullable (null = ADMIN audience),
--    plus a tripRequestId deep-link column (mirrors tripId).
-- 3. TripRequest: a client-submitted trip proposal (PENDING) that an admin later
--    approves (creating the actual Trip, Slice 2) or rejects. Owning-client FK cascades.
--
-- The new NotificationType values are NOT used within this migration, so the whole
-- script is transaction-safe on PostgreSQL 12+ (the target is Neon PG15).

-- AlterEnum: request-workflow notification types.
ALTER TYPE "NotificationType" ADD VALUE 'TRIP_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'TRIP_REQUEST_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'TRIP_REQUEST_REJECTED';

-- AlterTable: Notification audience-aware clientId + request deep-link.
ALTER TABLE "Notification" ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "tripRequestId" TEXT;

-- CreateEnum: trip-request status.
CREATE TYPE "TripRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable: TripRequest.
CREATE TABLE "TripRequest" (
    "id" TEXT NOT NULL,
    "status" "TripRequestStatus" NOT NULL DEFAULT 'PENDING',
    "clientId" TEXT NOT NULL,
    "reference" TEXT,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "driverName" TEXT,
    "customerId" TEXT,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "originLat" DOUBLE PRECISION,
    "originLng" DOUBLE PRECISION,
    "destinationLat" DOUBLE PRECISION,
    "destinationLng" DOUBLE PRECISION,
    "stops" JSONB,
    "distanceKm" DOUBLE PRECISION,
    "durationMins" INTEGER,
    "notes" TEXT,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "tripId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex.
CREATE INDEX "TripRequest_clientId_idx" ON "TripRequest"("clientId");
CREATE INDEX "TripRequest_status_idx" ON "TripRequest"("status");

-- AddForeignKey: owning client (cascade on client delete — a request is transient).
ALTER TABLE "TripRequest" ADD CONSTRAINT "TripRequest_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
