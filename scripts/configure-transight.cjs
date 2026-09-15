/**
 * Configure the TRANSIGHT GpsIntegration row from .env TRANSIGHT_API.
 * Writes the SAME columns the PUT /gps-integrations/transight endpoint writes
 * (mirrors GpsIntegrationService.upsert). NEVER prints/logs the credential —
 * output is masked exactly like the service's mask() (hasCredential + ********).
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

const key = process.env.TRANSIGHT_API;
if (!key || !key.trim()) {
  console.error('ERROR: TRANSIGHT_API is missing or empty in .env');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE_URL = 'https://compass.transight.in/external/api/v2';

(async () => {
  const base = { baseUrl: BASE_URL, active: true, system: 'Compass', pollIntervalSec: 300 };
  const row = await prisma.gpsIntegration.upsert({
    where: { provider: 'TRANSIGHT' },
    update: { ...base, credential: key }, // only overwrite credential with the supplied one
    create: { provider: 'TRANSIGHT', ...base, credential: key },
  });

  // Masked readback (identical shape to GpsIntegrationService.mask()).
  console.log(JSON.stringify({
    provider: row.provider,
    active: row.active,
    baseUrl: row.baseUrl,
    system: row.system,
    pollIntervalSec: row.pollIntervalSec,
    hasCredential: !!row.credential,
    credential: row.credential ? '********' : null,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
  }, null, 2));

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('CONFIG ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
