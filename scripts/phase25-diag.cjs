/**
 * Phase 2.5 read-only diagnostic: explain the 15-assigned → 17-unassigned change.
 * No writes. No secrets (client email omitted; ids/names/timestamps/counts only).
 */
const fs = require('fs');
const path = require('path');
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
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const clients = await prisma.client.findMany({ select: { id: true, name: true, createdAt: true } });
  const targetId = 'cmsmt439u009hhtz8pranivax'; // the client the 15 were assigned to at Phase 2
  const targetExists = clients.some((c) => c.id === targetId);

  const vehicles = await prisma.vehicle.findMany({
    select: {
      vehicleNumber: true, providerName: true, providerVehicleId: true,
      clientId: true, createdAt: true, updatedAt: true,
      _count: { select: { locationHistory: true, trips: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(JSON.stringify({
    clientCount: clients.length,
    clients: clients.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt })),
    targetClientStillExists: targetExists,
    vehicleCount: vehicles.length,
    assigned: vehicles.filter((v) => v.clientId).length,
    unassigned: vehicles.filter((v) => !v.clientId).length,
    vehicles: vehicles.map((v) => ({
      n: v.vehicleNumber, pid: v.providerVehicleId, clientId: v.clientId,
      created: v.createdAt, updated: v.updatedAt,
      history: v._count.locationHistory, trips: v._count.trips,
    })),
  }, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('DIAG ERROR:', e.message); await prisma.$disconnect(); process.exit(1); });
