/**
 * Phase 2.5 dual-provider DB verification (read-only). Confirms AiroTrack preserved,
 * Transight created by sync, no duplicates, clientId untouched. No secrets printed.
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const byProvider = await prisma.$queryRawUnsafe(
    `SELECT "providerName", COUNT(*)::int AS n FROM "Vehicle" GROUP BY "providerName" ORDER BY 1`,
  );
  const dups = await prisma.$queryRawUnsafe(
    `SELECT "providerName","providerVehicleId", COUNT(*)::int AS n FROM "Vehicle"
     GROUP BY "providerName","providerVehicleId" HAVING COUNT(*)>1`,
  );
  const total = await prisma.vehicle.count();
  const assigned = await prisma.vehicle.count({ where: { NOT: { clientId: null } } });

  const airo = await prisma.vehicle.findMany({ where: { providerName: 'airotrack' }, select: { clientId: true } });
  const trans = await prisma.vehicle.findMany({
    where: { providerName: 'transight' },
    select: { vehicleNumber: true, providerVehicleId: true, imei: true, clientId: true, createdAt: true },
    orderBy: { vehicleNumber: 'asc' },
  });
  const integrations = await prisma.gpsIntegration.findMany({ orderBy: { provider: 'asc' } });

  console.log(JSON.stringify({
    byProvider,
    total,
    assigned,
    unassigned: total - assigned,
    duplicates: dups,
    airotrack: {
      count: airo.length,
      allUnassigned: airo.every((v) => v.clientId === null),
    },
    transight: {
      count: trans.length,
      allProviderNameTransight: true,
      allUnassigned: trans.every((v) => v.clientId === null),
      allHaveImei: trans.every((v) => v.imei),
      sample: trans.slice(0, 4).map((v) => ({ n: v.vehicleNumber, pid: v.providerVehicleId, imei: v.imei, clientId: v.clientId })),
    },
    integrations: integrations.map((r) => ({
      provider: r.provider, active: r.active, hasCredential: !!r.credential,
      pollIntervalSec: r.pollIntervalSec, lastSyncedAt: r.lastSyncedAt, lastError: r.lastError,
    })),
  }, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('VERIFY ERROR:', e.message); await prisma.$disconnect(); process.exit(1); });
