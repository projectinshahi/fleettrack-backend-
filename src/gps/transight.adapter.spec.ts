import { TransightAdapter } from './transight.adapter';

describe('TransightAdapter', () => {
  it('parses the "lat lng" location string', () => {
    expect(TransightAdapter.parseLocation('027.125795 078.454375')).toEqual({
      latitude: 27.125795,
      longitude: 78.454375,
    });
    expect(TransightAdapter.parseLocation('bad')).toBeNull();
    expect(TransightAdapter.parseLocation(null)).toBeNull();
  });

  // Transight sends local (IST) time with no tz marker. Treating it as UTC dated every
  // position 5.5h in the future, which made `now - fixTime` negative and defeated every
  // downstream freshness check. Verified against production 2026-08-14.
  it('parses tz-less time as IST (+05:30), not UTC', () => {
    const d = TransightAdapter.parseProviderTime('2022-02-08 14:17:35');
    expect(d?.toISOString()).toBe('2022-02-08T08:47:35.000Z');
  });

  it('rejects unusable timestamps instead of inventing one', () => {
    expect(TransightAdapter.parseProviderTime('')).toBeNull();
    expect(TransightAdapter.parseProviderTime(null)).toBeNull();
    expect(TransightAdapter.parseProviderTime('not-a-date')).toBeNull();
  });

  it('honours an explicit offset override (other-timezone accounts)', () => {
    const d = TransightAdapter.parseProviderTime('2022-02-08 14:17:35', 0);
    expect(d?.toISOString()).toBe('2022-02-08T14:17:35.000Z');
  });

  it('accepts status 1, throws on 4 (rate limit) and other statuses', () => {
    expect(() => TransightAdapter.assertOk({ status: 1 }, 'x')).not.toThrow();
    expect(() => TransightAdapter.assertOk({ status: 4 }, 'x')).toThrow(
      /rate limit/i,
    );
    expect(() =>
      TransightAdapter.assertOk({ status: 5, messages: ['Data not available'] }, 'x'),
    ).toThrow(/status 5/);
  });

  it('normalizes inventory from get_all_vehicles', () => {
    const v = TransightAdapter.normalizeInventory({
      status: 1,
      data: [{ vehicle_number: 'API TEST', vehicle_id: 'VID9', imei: '123' }],
    });
    expect(v).toEqual([
      {
        providerName: 'transight',
        providerVehicleId: 'VID9',
        vehicleNumber: 'API TEST',
        imei: '123',
        gpsDeviceId: '123',
      },
    ]);
  });

  it('normalizes a position, joining IMEI → vehicle_id, never inventing battery', () => {
    const pos = TransightAdapter.normalizePosition(
      {
        vehicle: 'API TEST',
        imei: '123',
        ignition: true,
        speed: 10.5,
        location: '027.125795 078.454375',
        time: '2022-02-08 14:17:35',
      },
      (imei) =>
        imei === '123' ? { vehicleId: 'VID9', vehicleNumber: 'API TEST' } : undefined,
    );

    expect(pos).toMatchObject({
      providerName: 'transight',
      providerVehicleId: 'VID9',
      vehicleNumber: 'API TEST',
      imei: '123',
      latitude: 27.125795,
      longitude: 78.454375,
      speed: 10.5,
      ignition: true,
      batteryVoltage: null,
      charge: null,
    });
    // 14:17:35 IST → 08:47:35 UTC
    expect(pos!.providerTimestamp?.toISOString()).toBe('2022-02-08T08:47:35.000Z');
  });

  it('falls back to IMEI as providerVehicleId when inventory misses', () => {
    const pos = TransightAdapter.normalizePosition(
      { vehicle: 'X', imei: '999', location: '1 2', time: '', speed: 0, ignition: false },
      () => undefined,
    );
    expect(pos!.providerVehicleId).toBe('999');
    expect(pos!.imei).toBe('999');
  });

  it('returns null when there is no IMEI and no resolvable id', () => {
    const pos = TransightAdapter.normalizePosition(
      { vehicle: 'X', location: '1 2', speed: 0, ignition: false },
      () => undefined,
    );
    expect(pos).toBeNull();
  });
});

/**
 * Identity-fallback flagging. Transight positions carry no vehicle_id, so the adapter
 * substitutes the IMEI when its inventory cache cannot resolve one. That substitution is
 * now flagged, because the sync must not CREATE a vehicle on an unproven identity — doing
 * so is what produced 12 duplicate rows in production on 2026-08-14.
 */
describe('TransightAdapter identity fallback flag', () => {
  const rawPosition = {
    vehicle: 'KL84D1577',
    imei: '860560066144082',
    ignition: true,
    speed: 12,
    location: '010.995818 075.991227',
    time: '2026-08-14 17:47:49',
  };

  it('marks identity as PROVEN when the inventory cache resolves a vehicle_id', () => {
    const pos = TransightAdapter.normalizePosition(rawPosition, () => ({
      vehicleId: '228068',
      vehicleNumber: 'KL84D1577',
    }));

    expect(pos!.providerVehicleId).toBe('228068');
    expect(pos!.identityIsFallback).toBe(false);
  });

  it('marks identity as FALLBACK when the cache misses and the IMEI stands in', () => {
    const pos = TransightAdapter.normalizePosition(rawPosition, () => undefined);

    expect(pos!.providerVehicleId).toBe('860560066144082'); // the IMEI, not a vehicle_id
    expect(pos!.identityIsFallback).toBe(true);
  });

  it('still drops a position that has neither a resolvable id nor an IMEI', () => {
    expect(
      TransightAdapter.normalizePosition(
        { vehicle: 'X', location: '1 2', speed: 0, ignition: false, time: '' },
        () => undefined,
      ),
    ).toBeNull();
  });
});

/**
 * Inventory caching + rate-limit guarantees.
 *
 * get_all_vehicles is capped at 100 calls/DAY while Transight is polled every 300s (288
 * ticks/day), so the adapter's TTL and attempt-floor are the only things standing between
 * a normal day and a burned quota. These exercise the instance (not the pure statics), so
 * global.fetch is stubbed.
 */
describe('TransightAdapter inventory cache + rate limiting', () => {
  const CONFIG = { baseUrl: 'https://x/api/v2', credential: 'k', system: 'Compass' };

  const invBody = (rows: any[]) => ({ status: 1, data: rows });
  const INV_ROWS = [
    { vehicle_number: 'KL84E0577', vehicle_id: '228085', imei: '862567078385031' },
  ];
  const POS_BODY = {
    status: 1,
    data: [
      {
        vehicle: 'KL84E0577',
        imei: '862567078385031',
        ignition: true,
        speed: 10,
        location: '011.0 076.0',
        time: '2026-09-11 12:00:00',
      },
    ],
  };

  /** Route each stubbed call by endpoint and record how many inventory calls happened. */
  function stubFetch(handlers: { inventory: () => any; positions?: () => any }) {
    const calls = { inventory: 0, positions: 0 };
    global.fetch = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('get_all_vehicles_last_data')) {
        calls.positions++;
        return { ok: true, json: async () => (handlers.positions ?? (() => POS_BODY))() } as any;
      }
      calls.inventory++;
      return { ok: true, json: async () => handlers.inventory() } as any;
    }) as any;
    return calls;
  }

  // Save and RESTORE the real fetch rather than deleting it: Jest reuses a worker process
  // across suites, so `delete global.fetch` would strip fetch from every suite that runs
  // after this one in the same worker — an intermittent, order-dependent failure.
  const realFetch = global.fetch;
  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = realFetch;
  });

  it('H1. cachedVehicles() is empty before any fetch and populated after one', async () => {
    stubFetch({ inventory: () => invBody(INV_ROWS) });
    const a = new TransightAdapter(CONFIG);

    expect(a.cachedVehicles()).toEqual([]);
    await a.getLatestPositions();

    expect(a.cachedVehicles()).toHaveLength(1);
    expect(a.cachedVehicles()[0]).toMatchObject({
      providerVehicleId: '228085',
      vehicleNumber: 'KL84E0577',
      imei: '862567078385031',
    });
  });

  it('H2. two position fetches inside the TTL spend only ONE inventory call', async () => {
    const calls = stubFetch({ inventory: () => invBody(INV_ROWS) });
    const a = new TransightAdapter(CONFIG);

    await a.getLatestPositions();
    await a.getLatestPositions();

    expect(calls.inventory).toBe(1); // the 100/day cap depends on this
    expect(calls.positions).toBe(2); // positions are capped at 500/day, unaffected
  });

  it('H3. a FAILING inventory call does not retry on the next poll (attempt floor)', async () => {
    // status 4 is Transight's rate-limit response — the exact case where retrying is worst.
    const calls = stubFetch({ inventory: () => ({ status: 4, messages: ['limit'] }) });
    const a = new TransightAdapter(CONFIG);

    const first = await a.getLatestPositions();
    const second = await a.getLatestPositions();

    // Without the 15-minute floor this would be one inventory call per poll = 288/day.
    expect(calls.inventory).toBe(1);
    // Fail-soft preserved: positions still flow, just with fallback identities.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].identityIsFallback).toBe(true);
  });

  it('H4. an empty-but-successful inventory response does not wipe a working cache', async () => {
    let body: any = invBody(INV_ROWS);
    const calls = stubFetch({ inventory: () => body });
    const a = new TransightAdapter(CONFIG);

    await a.getLatestPositions();
    expect(a.cachedVehicles()).toHaveLength(1);

    // Force a refresh past the TTL, this time returning an empty (but valid) list.
    (a as any).inventoryFetchedAt = 1;
    (a as any).inventoryAttemptedAt = 0;
    body = invBody([]);
    const positions = await a.getLatestPositions();

    // The old identities survive — losing them would make every position fall back to an
    // IMEI key, which is how 12 duplicate rows were created on 2026-08-14.
    expect(a.cachedVehicles()).toHaveLength(1);
    expect(positions[0].providerVehicleId).toBe('228085');
    expect(positions[0].identityIsFallback).toBe(false);
    expect(calls.inventory).toBe(2);
  });
});
