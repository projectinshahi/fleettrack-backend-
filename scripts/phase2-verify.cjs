/**
 * Phase 2 GPS cutover — read-only runtime verification.
 * Never prints credentials/secrets: only booleans, counts, endpoints (query-stripped),
 * vehicle numbers, and clientId cuids (not secret). Loads .env locally without echoing it.
 */
const fs = require('fs');
const path = require('path');

// --- load .env into process.env without printing any value ---
const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!(k in process.env)) process.env[k] = v;
}

const stripQuery = (u) => {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(unparseable url)';
  }
};

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const out = {};

  // 1) Structures ----------------------------------------------------------
  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name='Vehicle' AND column_name IN ('clientId','imei')`,
  );
  const idx = await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes
     WHERE tablename='Vehicle' AND indexname='Vehicle_providerName_providerVehicleId_key'`,
  );
  const enumRows = await prisma.$queryRawUnsafe(
    `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
     WHERE t.typname='GpsProviderName' ORDER BY e.enumsortorder`,
  );
  const tbl = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_name='GpsIntegration'`,
  );

  const colMap = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
  out.structures = {
    'Vehicle.imei exists': 'imei' in colMap,
    'Vehicle.clientId nullable': colMap.clientId === 'YES',
    'unique(providerName,providerVehicleId)': idx.length === 1,
    'GpsProviderName enum': enumRows.map((r) => r.enumlabel).join(',') || '(missing)',
    'GpsIntegration table': tbl.length === 1,
  };

  // 2) GpsIntegration (masked) --------------------------------------------
  const integrations = await prisma.gpsIntegration.findMany({ orderBy: { provider: 'asc' } });
  out.integrations = integrations.map((r) => ({
    provider: r.provider,
    active: r.active,
    endpoint: stripQuery(r.baseUrl),
    hasCredential: !!r.credential,
    pollIntervalSec: r.pollIntervalSec,
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.lastError,
    system: r.system,
  }));

  // 3) Vehicle inventory ---------------------------------------------------
  const total = await prisma.vehicle.count();
  const assigned = await prisma.vehicle.count({ where: { NOT: { clientId: null } } });
  const unassigned = await prisma.vehicle.count({ where: { clientId: null } });
  const byProvider = await prisma.$queryRawUnsafe(
    `SELECT "providerName", COUNT(*)::int AS n FROM "Vehicle" GROUP BY "providerName" ORDER BY 1`,
  );
  out.inventory = { total, assigned, unassigned, byProvider };

  // 4) Duplicates by provider identity ------------------------------------
  const dups = await prisma.$queryRawUnsafe(
    `SELECT "providerName","providerVehicleId", COUNT(*)::int AS n
     FROM "Vehicle" GROUP BY "providerName","providerVehicleId" HAVING COUNT(*)>1`,
  );
  out.duplicates = dups;

  // 5) Existing rows identity snapshot (for preservation cross-check) ------
  const rows = await prisma.vehicle.findMany({
    select: { vehicleNumber: true, providerName: true, providerVehicleId: true, clientId: true, imei: true },
    orderBy: { vehicleNumber: 'asc' },
  });
  out.vehicles = rows.map((r) => ({
    vehicleNumber: r.vehicleNumber,
    providerName: r.providerName,
    providerVehicleId: r.providerVehicleId,
    assigned: r.clientId !== null,
    clientId: r.clientId, // cuid, not a secret — used to confirm assignment is unchanged
    imei: r.imei,
  }));

  // 6) Live AiroTrack cross-check (identity + casing) ----------------------
  const raw = process.env.AIROTRACK_API;
  if (raw) {
    try {
      const res = await fetch(raw);
      const json = res.ok ? await res.json() : null;
      const arr = Array.isArray(json) ? json : [];
      const liveIds = arr
        .map((i) => (i && i.vehicleNumber != null ? String(i.vehicleNumber) : null))
        .filter(Boolean)
        .sort();
      const dbAiro = new Set(
        rows.filter((r) => r.providerName === 'airotrack').map((r) => r.providerVehicleId),
      );
      const liveSet = new Set(liveIds);
      out.airotrack = {
        httpOk: res.ok,
        liveCount: liveIds.length,
        liveVehicleNumbers: liveIds,
        dbAirotrackCount: dbAiro.size,
        inLiveNotInDb: liveIds.filter((id) => !dbAiro.has(id)),
        inDbNotInLive: [...dbAiro].filter((id) => !liveSet.has(id)),
      };
    } catch (e) {
      out.airotrack = { error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    out.airotrack = { note: 'AIROTRACK_API env not set' };
  }

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('VERIFY ERROR:', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
