// Run BEFORE applying the gps_provider_foundation migration to confirm the
// @@unique([providerName, providerVehicleId]) index won't fail on existing data.
//   node scripts/check-provider-duplicates.cjs
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const dupes = await p.$queryRawUnsafe(
    `SELECT "providerName","providerVehicleId",COUNT(*)::int AS count
     FROM "Vehicle" WHERE "providerVehicleId" IS NOT NULL
     GROUP BY "providerName","providerVehicleId" HAVING COUNT(*) > 1`,
  );
  if (dupes.length === 0) {
    console.log('OK: no (providerName, providerVehicleId) duplicates. Safe to apply.');
  } else {
    console.error('BLOCKED: resolve these duplicates before applying the migration:');
    console.error(JSON.stringify(dupes, null, 2));
    process.exitCode = 1;
  }
  await p.$disconnect();
})();
