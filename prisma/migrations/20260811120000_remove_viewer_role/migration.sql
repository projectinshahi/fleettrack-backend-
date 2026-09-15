-- Remove the legacy VIEWER role. The product supports ADMIN + (synthetic) CLIENT only.
-- Postgres cannot drop a value from an enum in place, so we convert existing rows first,
-- then recreate the type without VIEWER. Safe and non-destructive (no data loss).

-- 1. Convert any existing VIEWER users to ADMIN (VIEWER is no longer a valid role).
UPDATE "User" SET "role" = 'ADMIN' WHERE "role" = 'VIEWER';

-- 2. Drop the column default so the enum value can be removed.
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;

-- 3. Recreate the Role enum without VIEWER and re-point the column at it.
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('ADMIN');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
DROP TYPE "Role_old";

-- 4. Restore the default (now ADMIN).
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'ADMIN';
