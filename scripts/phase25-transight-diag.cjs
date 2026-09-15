/**
 * READ-ONLY Transight discrepancy diagnostic. Calls the raw Compass endpoints with the
 * stored credential (NEVER printed) and inspects the DB. No writes, no vehicle creation.
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

const TARGET_IMEI = '860560066144082';
const TARGET_NUM = 'KL84D1577';
const TARGET_VID = '228068';

async function post(base, endpoint, apikey) {
  const res = await fetch(`${base.replace(/\/+$/, '')}/${endpoint}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey }), // credential used here only, never logged
  });
  const json = await res.json();
  return { httpOk: res.ok, json };
}

(async () => {
  const row = await prisma.gpsIntegration.findUnique({ where: { provider: 'TRANSIGHT' } });
  if (!row || !row.credential) { console.error('TRANSIGHT not configured'); process.exit(1); }
  const base = row.baseUrl;
  const key = row.credential; // never printed

  const inv = await post(base, 'get_all_vehicles', key);
  const pos = await post(base, 'get_all_vehicles_last_data', key);
  const invData = Array.isArray(inv.json?.data) ? inv.json.data : [];
  const posData = Array.isArray(pos.json?.data) ? pos.json.data : [];

  const posByImei = new Map();
  for (const p of posData) if (p && p.imei != null) posByImei.set(String(p.imei), p);
  const invImeis = new Set(invData.map((v) => (v.imei != null ? String(v.imei) : null)));

  const table = invData.map((v) => {
    const imei = v.imei != null ? String(v.imei) : null;
    const p = imei ? posByImei.get(imei) : undefined;
    return {
      vehicle_number: v.vehicle_number,
      vehicle_id: String(v.vehicle_id),
      imei,
      inventory: 'Y',
      position: p ? 'Y' : 'N',
      mapped: p ? 'Y' : 'N',
    };
  });

  const dbTrans = await prisma.vehicle.findMany({
    where: { providerName: 'transight' },
    select: { vehicleNumber: true, providerVehicleId: true, imei: true, latitude: true, longitude: true, lastProviderUpdate: true },
    orderBy: { vehicleNumber: 'asc' },
  });

  console.log(JSON.stringify({
    inventory: { status: inv.json?.status, count: invData.length },
    positions: { status: pos.json?.status, count: posData.length },
    target: {
      imei: TARGET_IMEI, vehicle_number: TARGET_NUM, vehicle_id: TARGET_VID,
      inInventory: invData.some((v) => String(v.vehicle_id) === TARGET_VID || String(v.imei) === TARGET_IMEI),
      inPositions_byImei: posByImei.has(TARGET_IMEI),
      inPositions_byNumber: posData.some((p) => p.vehicle === TARGET_NUM),
      matchingPositionObject: posByImei.get(TARGET_IMEI) || null,
    },
    table,
    positionsNotInInventory: posData
      .filter((p) => !invImeis.has(p.imei != null ? String(p.imei) : null))
      .map((p) => ({ vehicle: p.vehicle, imei: p.imei != null ? String(p.imei) : null })),
    db: {
      transightCount: dbTrans.length,
      hasTarget: dbTrans.some((v) => v.providerVehicleId === TARGET_VID || v.imei === TARGET_IMEI),
      rows: dbTrans,
    },
  }, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('DIAG ERROR:', e.message); await prisma.$disconnect(); process.exit(1); });
