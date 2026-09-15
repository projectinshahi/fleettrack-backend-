-- TCM-03.2: attach a RECEIPT file to a specific trip-cost component.
-- Additive + nullable → existing FileAsset rows (POD media, general receipts) stay valid.

-- CreateEnum
CREATE TYPE "CostComponent" AS ENUM ('FUEL', 'TOLLS', 'ALLOWANCE', 'PARKING', 'MAINTENANCE', 'MISC');

-- AlterTable
ALTER TABLE "FileAsset" ADD COLUMN "costComponent" "CostComponent";
