/**
 * Live Compass API test using the REAL compiled TransightAdapter (dist) and the
 * stored DB credential. Read-only (no DB writes, no vehicle creation). NEVER prints
 * the credential — the adapter sends it in the request body internally; this script
 * only reports counts, field-presence, and small non-secret vehicle samples.
 * One get_all_vehicles + one get_all_vehicles_last_data call (well under the limits).
 */
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const { PrismaClient } = require('@prisma/client');
const { TransightAdapter } = require(path.join(__dirname, '..', 'dist', 'gps', 'transight.adapter.js'));
const prisma = new PrismaClient();

(async () => {
  const row = await prisma.gpsIntegration.findUnique({ where: { provider: 'TRANSIGHT' } });
  if (!row || !row.credential) {
    console.error('ERROR: TRANSIGHT is not configured with a credential');
    process.exit(1);
  }

  const adapter = new TransightAdapter({
    baseUrl: row.baseUrl,
    credential: row.credential, // used internally by the adapter; never printed
    system: row.system,
  });

  const result = {};
  try {
    const inv = await adapter.getVehicles(); // POST /get_all_vehicles/ (throws unless status=1)
    result.authentication = 'OK (status=1)';
    result.inventoryCount = inv.length;
    result.inventoryFieldsPresent = inv.length
      ? {
          vehicle_number: inv[0].vehicleNumber != null,
          vehicle_id: inv[0].providerVehicleId != null,
          imei: inv[0].imei != null,
        }
      : null;
    result.inventorySample = inv.slice(0, 3).map((v) => ({
      vehicleNumber: v.vehicleNumber,
      providerVehicleId: v.providerVehicleId,
      imei: v.imei,
    }));

    const pos = await adapter.getLatestPositions(); // POST /get_all_vehicles_last_data/
    const invIds = new Set(inv.map((v) => v.providerVehicleId));
    result.positionsCount = pos.length;
    result.positionsWithValidCoords = pos.filter((p) => !(p.latitude === 0 && p.longitude === 0)).length;
    result.positionsWithImei = pos.filter((p) => p.imei).length;
    result.positionsMappedToInventoryVehicleId = pos.filter((p) => invIds.has(p.providerVehicleId)).length;
    result.positionsFellBackToImei = pos.filter((p) => !invIds.has(p.providerVehicleId)).length;
    result.positionSample = pos.slice(0, 3).map((p) => ({
      providerVehicleId: p.providerVehicleId,
      imei: p.imei,
      lat: p.latitude,
      lng: p.longitude,
      speed: p.speed,
      ignition: p.ignition,
      timeUTC: p.providerTimestamp ? p.providerTimestamp.toISOString() : null,
    }));
  } catch (e) {
    // Adapter error messages contain endpoint + status only (never the key).
    result.error = e.message;
  }

  console.log(JSON.stringify(result, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('LIVE TEST ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
