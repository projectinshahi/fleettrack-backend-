-- CreateTable
CREATE TABLE "TripBreadcrumb" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "heading" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripBreadcrumb_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripBreadcrumb_tripId_idx" ON "TripBreadcrumb"("tripId");

-- CreateIndex
CREATE INDEX "TripBreadcrumb_createdAt_idx" ON "TripBreadcrumb"("createdAt");

-- AddForeignKey
ALTER TABLE "TripBreadcrumb" ADD CONSTRAINT "TripBreadcrumb_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
