import { TrackingService } from './tracking.service';
import {
  NormalizedPosition,
  NormalizedVehicle,
} from '../gps/gps-provider.interface';

/**
 * Vehicle identity resolution during a provider sync.
 *
 * These tests exist because production accumulated 12 duplicate Transight vehicles: the
 * adapter substitutes the IMEI for `providerVehicleId` whenever its inventory cache is
 * cold, the sync looked the vehicle up by `providerVehicleId` only, missed the existing
 * row, and created a second one. `@@unique([providerName, providerVehicleId])` could not
 * catch it because the two keys genuinely differ.
 *
 * They are driven through the real `syncVehicles()` rather than the private upsert, so the
 * assertions cover the path that actually runs in production.
 */

/** Minimal in-memory Vehicle table — lets us assert on row identity and row COUNT. */
function makeStore(seed: any[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = 1000;

  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const vehicle = {
    findFirst: jest.fn(
      async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: jest.fn(async ({ where }: any = {}) =>
      where ? rows.filter((r) => matches(r, where)) : rows,
    ),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `new-${nextId++}`, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error('no such vehicle: ' + where.id);
      for (const [k, v] of Object.entries(data))
        if (v !== undefined) (row as any)[k] = v;
      return row;
    }),
  };

  const history: any[] = [];

  const prisma: any = {
    vehicle,
    vehicleLocationHistory: {
      findFirst: jest.fn(async ({ where }: any) => {
        const forVehicle = history.filter(
          (h) => h.vehicleId === where.vehicleId,
        );
        return forVehicle[forVehicle.length - 1] ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        history.push(data);
        return data;
      }),
      count: jest.fn(
        async ({ where }: any) =>
          history.filter((h) => h.vehicleId === where.vehicleId).length,
      ),
    },
    trip: { findMany: jest.fn(async () => []) },
    tripBreadcrumb: { createMany: jest.fn(async () => ({ count: 0 })) },
    gpsIntegration: { findMany: jest.fn(async () => []) },
  };

  return { prisma, vehicle, rows, history };
}

function makeService(
  store: ReturnType<typeof makeStore>,
  positions: NormalizedPosition[],
  providerEnum = 'TRANSIGHT',
  pollIntervalSec = 300,
  // Inventory the adapter would have cached. Defaults to [] so every pre-existing test
  // exercises the position path exactly as before.
  inventory: NormalizedVehicle[] = [],
  // AiroTrack-shaped providers do NOT implement cachedVehicles at all — that absence is
  // how they opt out of the gap-fill, so it has to be expressible here.
  opts: { withCachedVehicles?: boolean } = {},
) {
  const gateway: any = { emitVehicleUpdate: jest.fn() };
  const getVehicles = jest.fn(async () => inventory);
  const providerStub: any = {
    name: providerEnum.toLowerCase(),
    getLatestPositions: async () => positions,
    // Pinning this as a spy is what proves the gap-fill never spends a get_all_vehicles
    // call — the Transight inventory endpoint is capped at 100/day.
    getVehicles,
  };
  if (opts.withCachedVehicles !== false) {
    providerStub.cachedVehicles = () => inventory;
  }
  const gpsIntegration: any = {
    getActiveProviders: jest.fn(async () => [
      {
        config: { provider: providerEnum, pollIntervalSec, lastSyncedAt: null },
        provider: providerStub,
      },
    ]),
    markSynced: jest.fn(async () => undefined),
  };
  return {
    service: new TrackingService(store.prisma, gateway, gpsIntegration),
    gateway,
    getVehicles,
  };
}

/** A fresh Transight position for the KL84D1577 device from the production audit. */
const transightPos = (
  over: Partial<NormalizedPosition> = {},
): NormalizedPosition => ({
  providerName: 'transight',
  providerVehicleId: '228068',
  vehicleNumber: 'KL84D1577',
  imei: '860560066144082',
  gpsDeviceId: '860560066144082',
  latitude: 10.995818,
  longitude: 75.991227,
  speed: 12,
  ignition: true,
  batteryVoltage: null,
  charge: null,
  providerTimestamp: new Date(),
  ...over,
});

/** The existing legitimate row: keyed by vehicle_id, assigned to a client. */
const legitRow = () => ({
  id: 'cmsolbu900013htv0r6tnmpm1',
  vehicleName: 'KL84D1577',
  vehicleNumber: 'KL84D1577',
  gpsDeviceId: '860560066144082',
  providerName: 'transight',
  providerVehicleId: '228068',
  imei: '860560066144082',
  driverName: 'Real Driver',
  clientId: 'client-nesto',
  status: 'IDLE',
  isOnline: true,
  speed: 0,
  latitude: 10.9,
  longitude: 75.9,
  lastProviderUpdate: new Date(Date.now() - 10 * 60 * 1000),
  lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
});

describe('TrackingService vehicle identity resolution', () => {
  /* ---- A ---- */
  it('A. finds the existing vehicle by providerVehicleId and updates it', async () => {
    const store = makeStore([legitRow()]);
    const { service } = makeService(store, [transightPos()]);

    await service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows[0].id).toBe('cmsolbu900013htv0r6tnmpm1');
    expect(store.rows[0].speed).toBe(12);
  });

  /* ---- B ---- */
  it('B. providerVehicleId misses but IMEI matches → reuses the row, no duplicate', async () => {
    const store = makeStore([legitRow()]);
    // Inventory cache cold: the adapter substituted the IMEI for the vehicle_id.
    const { service } = makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
      }),
    ]);

    await service.syncVehicles();

    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1); // the duplicate that used to appear here
    expect(store.rows[0].id).toBe('cmsolbu900013htv0r6tnmpm1'); // same vehicle ID
    expect(store.rows[0].providerVehicleId).toBe('860560066144082'); // re-keyed
    expect(store.rows[0].speed).toBe(12); // and still received the position
  });

  it('B2. re-keys back to the real vehicle_id once inventory recovers, still one row', async () => {
    const store = makeStore([legitRow()]);

    // cycle 1: cold cache → IMEI key
    await makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
      }),
    ]).service.syncVehicles();
    // cycle 2: inventory back → real vehicle_id
    await makeService(store, [transightPos()]).service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].id).toBe('cmsolbu900013htv0r6tnmpm1');
    expect(store.rows[0].providerVehicleId).toBe('228068');
    expect(store.vehicle.create).not.toHaveBeenCalled();
  });

  /* ---- C ---- */
  it('C1. unknown vehicle on a FALLBACK identity → creates nothing, defers', async () => {
    const store = makeStore([]); // nothing to match
    const { service } = makeService(store, [
      transightPos({
        providerVehicleId: '999999999999999',
        imei: '999999999999999',
        identityIsFallback: true,
      }),
    ]);

    await service.syncVehicles();

    // A cold cache cannot tell "new vehicle" from "existing vehicle we failed to
    // resolve", so it must not guess — that guess is what created the 12 duplicates.
    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it('C2. unknown vehicle on a PROVEN identity → still created (behaviour unchanged)', async () => {
    const store = makeStore([]);
    const { service } = makeService(store, [
      transightPos({ providerVehicleId: '228099', imei: '860560069999999' }),
    ]);

    await service.syncVehicles();

    expect(store.vehicle.create).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].clientId).toBeNull(); // lands as unassigned inventory
  });

  /* ---- D ---- */
  it('D. AiroTrack is unaffected — no IMEI, no fallback flag, creates and updates normally', async () => {
    const airoPos: NormalizedPosition = {
      providerName: 'airotrack',
      providerVehicleId: 'KL85B7233',
      vehicleNumber: 'KL85B7233',
      imei: null,
      gpsDeviceId: 'KL85B7233',
      latitude: 11.05,
      longitude: 75.98,
      speed: 30,
      ignition: true,
      batteryVoltage: 28.1,
      charge: true,
      providerTimestamp: new Date(),
    };

    const store = makeStore([]);
    const first = makeService(store, [airoPos], 'AIROTRACK', 60);
    await first.service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].providerName).toBe('airotrack');

    // second cycle updates the same row rather than adding another
    const second = makeService(
      store,
      [{ ...airoPos, speed: 44 }],
      'AIROTRACK',
      60,
    );
    await second.service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].speed).toBe(44);
    expect(store.vehicle.create).toHaveBeenCalledTimes(1);
  });

  /* ---- E ---- */
  it('E. client assignment survives an IMEI re-key', async () => {
    const store = makeStore([legitRow()]);
    const { service } = makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
      }),
    ]);

    await service.syncVehicles();

    expect(store.rows[0].clientId).toBe('client-nesto');
    expect(store.rows[0].driverName).toBe('Real Driver');
    // the sync must never write clientId at all
    for (const call of store.vehicle.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('clientId');
    }
  });

  /* ---- F ---- */
  it('F. location history stays attached to the SAME vehicle id across a re-key', async () => {
    const store = makeStore([legitRow()]);

    // cycle 1 (proven identity) records history against the legit id
    await makeService(store, [transightPos()]).service.syncVehicles();
    // cycle 2 arrives with a fallback IMEI identity and moves far enough to persist
    await makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
        latitude: 11.5,
        longitude: 76.5,
      }),
    ]).service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    const id = store.rows[0].id;
    expect(id).toBe('cmsolbu900013htv0r6tnmpm1');
    expect(store.history.length).toBeGreaterThan(0);
    // every history point belongs to the one surviving vehicle
    expect(store.history.every((h) => h.vehicleId === id)).toBe(true);
  });
});

/**
 * Inventory-first gap-fill.
 *
 * Transight's two endpoints disagree: get_all_vehicles listed 20 vehicles while
 * get_all_vehicles_last_data returned 18 (verified live 2026-09-11). The sync was
 * position-first, so KL84D9877 (228282) and KL84E0577 (228085) — real vehicles that have
 * simply never sent a fix — had no row at all. These tests pin the gap-fill that fixes
 * that, and pin the two things it must never cost: an extra inventory API call, or a
 * duplicate row.
 */
describe('TrackingService inventory-first gap-fill', () => {
  /** A Transight inventory entry (NormalizedVehicle — no position fields at all). */
  const invVehicle = (
    over: Partial<NormalizedVehicle> = {},
  ): NormalizedVehicle => ({
    providerName: 'transight',
    providerVehicleId: '228085',
    vehicleNumber: 'KL84E0577',
    imei: '862567078385031',
    gpsDeviceId: '862567078385031',
    ...over,
  });

  it('G1. creates a row for an inventory vehicle that has never sent a position', async () => {
    const store = makeStore([]);
    const { service, gateway } = makeService(store, [], 'TRANSIGHT', 300, [
      invVehicle(),
    ]);

    await service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0];
    expect(row.vehicleNumber).toBe('KL84E0577');
    expect(row.providerVehicleId).toBe('228085');
    expect(row.imei).toBe('862567078385031');
    expect(row.status).toBe('OFFLINE');
    expect(row.isOnline).toBe(false);
    expect(row.clientId).toBeNull();
    // No invented GPS: the create omits lat/lng entirely so the column defaults stand.
    expect(row.latitude).toBeUndefined();
    expect(row.longitude).toBeUndefined();
    // No forged freshness.
    expect(row.lastProviderUpdate).toBeNull();
    expect(row.lastSeenAt).toBeNull();
    // A vehicle with no position must not be broadcast to live maps.
    expect(gateway.emitVehicleUpdate).not.toHaveBeenCalled();
  });

  it('G2. is idempotent — repeated syncs never create a second row', async () => {
    const store = makeStore([]);
    const inv = [invVehicle()];

    await makeService(store, [], 'TRANSIGHT', 300, inv).service.syncVehicles();
    await makeService(store, [], 'TRANSIGHT', 300, inv).service.syncVehicles();
    await makeService(store, [], 'TRANSIGHT', 300, inv).service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.vehicle.create).toHaveBeenCalledTimes(1);
  });

  it('G3. a vehicle in BOTH inventory and positions gets ONE row, and the position wins', async () => {
    const store = makeStore([]);
    const { service } = makeService(
      store,
      [transightPos()], // 228068, speed 12, fresh
      'TRANSIGHT',
      300,
      [invVehicle({ providerVehicleId: '228068', vehicleNumber: 'KL84D1577', imei: '860560066144082' })],
    );

    await service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.vehicle.create).toHaveBeenCalledTimes(1);
    // Real telemetry, not the OFFLINE placeholder — the gap-fill must never overwrite.
    expect(store.rows[0].speed).toBe(12);
    expect(store.rows[0].status).not.toBe('OFFLINE');
    expect(store.rows[0].isOnline).toBe(true);
  });

  it('G4. heals a legacy IMEI-keyed row instead of duplicating it', async () => {
    // A row created during a cold-cache era, keyed by IMEI rather than vehicle_id.
    const store = makeStore([
      {
        ...legitRow(),
        id: 'legacy-row',
        vehicleNumber: 'KL84E0577',
        providerVehicleId: '862567078385031',
        imei: '862567078385031',
      },
    ]);
    const { service } = makeService(store, [], 'TRANSIGHT', 300, [invVehicle()]);

    await service.syncVehicles();

    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].id).toBe('legacy-row');
    expect(store.rows[0].providerVehicleId).toBe('228085'); // re-keyed to the real id
  });

  it('G5. never spends a get_all_vehicles call — the 100/day cap is untouched', async () => {
    const store = makeStore([]);
    const { service, getVehicles } = makeService(store, [transightPos()], 'TRANSIGHT', 300, [
      invVehicle(),
    ]);

    await service.syncVehicles();

    // The gap-fill reads the adapter's already-cached list, never the network.
    expect(getVehicles).not.toHaveBeenCalled();
  });

  it('G6. AiroTrack (no cachedVehicles method) is a complete no-op for the gap-fill', async () => {
    const airoPos: NormalizedPosition = {
      providerName: 'airotrack',
      providerVehicleId: 'KL85B7233',
      vehicleNumber: 'KL85B7233',
      imei: null,
      gpsDeviceId: 'KL85B7233',
      latitude: 11.05,
      longitude: 75.98,
      speed: 30,
      ignition: true,
      batteryVoltage: 28.1,
      charge: true,
      providerTimestamp: new Date(),
    };

    const store = makeStore([]);
    // withCachedVehicles:false models the real AiroTrackAdapter, which does not implement
    // the optional method — its inventory IS its positions.
    const { service, getVehicles } = makeService(
      store,
      [airoPos],
      'AIROTRACK',
      60,
      [invVehicle()], // would be created if the opt-out failed
      { withCachedVehicles: false },
    );

    await service.syncVehicles();

    expect(store.rows).toHaveLength(1); // the position row only
    expect(store.rows[0].providerName).toBe('airotrack');
    expect(getVehicles).not.toHaveBeenCalled(); // no second HTTP GET
  });

  it('G7. never touches client assignment or driver on an existing row', async () => {
    const store = makeStore([legitRow()]); // assigned to client-nesto
    const { service } = makeService(store, [], 'TRANSIGHT', 300, [
      invVehicle({
        providerVehicleId: '228068',
        vehicleNumber: 'KL84D1577',
        imei: '860560066144082',
      }),
    ]);

    await service.syncVehicles();

    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows[0].clientId).toBe('client-nesto');
    expect(store.rows[0].driverName).toBe('Real Driver');
    for (const call of store.vehicle.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('clientId');
      expect(call[0].data).not.toHaveProperty('driverName');
    }
  });

  it('G8. a gap-fill failure never discards the positions already synced', async () => {
    // Seed the position's vehicle so the position path UPDATES (no create of its own);
    // the only create in this tick is then the gap-fill's, which we make fail.
    const store = makeStore([legitRow()]);
    store.vehicle.create.mockRejectedValueOnce(new Error('boom'));
    const { service } = makeService(store, [transightPos()], 'TRANSIGHT', 300, [
      invVehicle(), // a DIFFERENT vehicle, so the gap-fill attempts a create
    ]);

    await expect(service.syncVehicles()).resolves.not.toThrow();

    // The position telemetry still landed even though the inventory pass threw...
    const positioned = store.rows.find((r) => r.vehicleNumber === 'KL84D1577');
    expect(positioned?.speed).toBe(12);
    // ...and the failed gap-fill created nothing.
    expect(store.rows).toHaveLength(1);
  });
});

/**
 * Vehicle reads per sync cycle. A provider poll used to look every vehicle up with its own
 * query (one per position, then one per Transight inventory entry, for rows it had just
 * written). The cycle now reads the provider's vehicles once and keeps that set in step with
 * its own writes, so these pin both the read count and that the answers stay the same.
 */
describe('TrackingService per-cycle vehicle reads', () => {
  const airoRow = (i: number) => ({
    id: `airo-${i}`,
    vehicleName: `KL84C${7000 + i}`,
    vehicleNumber: `KL84C${7000 + i}`,
    gpsDeviceId: `KL84C${7000 + i}`,
    providerName: 'airotrack',
    providerVehicleId: `KL84C${7000 + i}`,
    imei: null,
    driverName: 'Driver',
    clientId: i % 2 ? 'client-nesto' : null,
    status: 'IDLE',
    isOnline: true,
    speed: 0,
    latitude: 11,
    longitude: 75.9,
    lastProviderUpdate: new Date(Date.now() - 2 * 60 * 1000),
    lastSeenAt: new Date(Date.now() - 2 * 60 * 1000),
  });
  const airoPos = (i: number): NormalizedPosition => ({
    providerName: 'airotrack',
    providerVehicleId: `KL84C${7000 + i}`,
    vehicleNumber: `KL84C${7000 + i}`,
    imei: null,
    gpsDeviceId: `KL84C${7000 + i}`,
    latitude: 11.01,
    longitude: 75.91,
    speed: 20,
    ignition: true,
    batteryVoltage: 28,
    charge: true,
    providerTimestamp: new Date(),
  });

  it('H1. an AiroTrack poll reads its vehicles once, not once per position', async () => {
    const store = makeStore(Array.from({ length: 24 }, (_, i) => airoRow(i)));
    const positions = Array.from({ length: 24 }, (_, i) => airoPos(i));
    const made = makeService(store, positions, 'AIROTRACK', 60, [], {
      withCachedVehicles: false,
    });
    const gateway = made.gateway as { emitVehicleUpdate: jest.Mock };

    await made.service.syncVehicles();

    expect(store.vehicle.findFirst).toHaveBeenCalledTimes(0);
    expect(store.vehicle.findMany).toHaveBeenCalledTimes(1);
    expect(store.vehicle.findMany).toHaveBeenCalledWith({
      where: { providerName: 'airotrack' },
    });
    // Every vehicle still updated and broadcast, no rows created.
    expect(store.vehicle.update).toHaveBeenCalledTimes(24);
    expect(gateway.emitVehicleUpdate).toHaveBeenCalledTimes(24);
    expect(store.vehicle.create).not.toHaveBeenCalled();
  });

  it('H2. a Transight poll plus its inventory gap-fill reads its vehicles once', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...legitRow(),
      id: `ts-${i}`,
      providerVehicleId: String(228000 + i),
      imei: String(860560066100000 + i),
    }));
    const store = makeStore(rows);
    const positions = rows
      .slice(0, 18)
      .map((r) =>
        transightPos({ providerVehicleId: r.providerVehicleId, imei: r.imei }),
      );
    const inventory = rows.map((r) => ({
      providerName: 'transight' as const,
      providerVehicleId: r.providerVehicleId,
      vehicleNumber: r.vehicleNumber,
      imei: r.imei,
      gpsDeviceId: r.imei,
    }));
    const { service } = makeService(
      store,
      positions,
      'TRANSIGHT',
      300,
      inventory,
    );

    await service.syncVehicles();

    expect(store.vehicle.findFirst).toHaveBeenCalledTimes(0);
    expect(store.vehicle.findMany).toHaveBeenCalledTimes(1);
    expect(store.vehicle.update).toHaveBeenCalledTimes(18);
    expect(store.vehicle.create).not.toHaveBeenCalled();
  });

  it('H3. a vehicle listed twice in one response is created once, then updated', async () => {
    const store = makeStore([]);
    const first = transightPos({ speed: 5 });
    const second = transightPos({ speed: 40, providerTimestamp: new Date() });
    const { service } = makeService(store, [first, second]);

    await service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.vehicle.create).toHaveBeenCalledTimes(1);
    expect(store.vehicle.update).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({ speed: 40 });
  });

  it('H4. a re-key made in the cycle is what the rest of the cycle sees', async () => {
    // Legacy row keyed by IMEI; the position arrives keyed by the real vehicle_id.
    const store = makeStore([
      { ...legitRow(), providerVehicleId: '860560066144082' },
    ]);
    const { service } = makeService(store, [transightPos()], 'TRANSIGHT', 300, [
      {
        providerName: 'transight',
        providerVehicleId: '228068',
        vehicleNumber: 'KL84D1577',
        imei: '860560066144082',
        gpsDeviceId: '860560066144082',
      },
    ]);

    await service.syncVehicles();

    // One IMEI lookup (the position's), none for the inventory entry: it finds the
    // re-keyed row in the cycle's set.
    expect(store.vehicle.findFirst).toHaveBeenCalledTimes(1);
    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      providerVehicleId: '228068',
      clientId: 'client-nesto',
    });
  });

  it('H5. the set lasts one cycle only — the next tick reads the table again', async () => {
    const store = makeStore([airoRow(1)]);
    const { service } = makeService(store, [airoPos(1)], 'AIROTRACK', 60, [], {
      withCachedVehicles: false,
    });

    await service.syncVehicles();
    await service.syncVehicles();

    expect(store.vehicle.findMany).toHaveBeenCalledTimes(2);
  });
});
