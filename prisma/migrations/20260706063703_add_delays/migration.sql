-- CreateEnum
CREATE TYPE "DelayCategory" AS ENUM ('TRAFFIC', 'WEATHER', 'BREAKDOWN', 'ACCIDENT', 'LOADING', 'CUSTOMER', 'DOCUMENTATION', 'OTHER');

-- CreateTable
CREATE TABLE "Delay" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "category" "DelayCategory" NOT NULL,
    "reason" TEXT,
    "remarks" TEXT,
    "durationMinutes" INTEGER NOT NULL DEFAULT 0,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'PORTAL',
    "reportedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Delay_tripId_idx" ON "Delay"("tripId");

-- CreateIndex
CREATE INDEX "Delay_category_idx" ON "Delay"("category");

-- AddForeignKey
ALTER TABLE "Delay" ADD CONSTRAINT "Delay_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
