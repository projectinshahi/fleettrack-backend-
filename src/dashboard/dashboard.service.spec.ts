import { DashboardService } from './dashboard.service';

/**
 * Weekly activity (DSH-05). The day buckets are computed in Asia/Kolkata (+05:30),
 * deliberately NOT in the server's local timezone, so these assertions must hold no
 * matter which timezone the test machine runs in — that is exactly what they guard.
 *
 * The harness asserts on the `where` handed to Prisma as well as on the output, so a
 * future change cannot start pulling the whole trip table and bucketing it in memory.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** An instant that falls on the given Asia/Kolkata calendar date at `hh:mm` IST. */
function istInstant(dateKey: string, hh = 12, mm = 0): Date {
  return new Date(
    Date.parse(`${dateKey}T00:00:00.000Z`) -
      IST_OFFSET_MS +
      hh * 60 * 60 * 1000 +
      mm * 60 * 1000,
  );
}

/** The Asia/Kolkata calendar date an instant falls on. */
function istKey(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function makeService(scheduledStarts: Date[] = []) {
  const findMany = jest
    .fn()
    .mockResolvedValue(scheduledStarts.map((scheduledStart) => ({ scheduledStart })));
  const prisma: any = { trip: { findMany } };
  return { service: new DashboardService(prisma), findMany };
}

const argsOf = (findMany: jest.Mock) =>
  findMany.mock.calls[0][0] as {
    where: { clientId?: string; scheduledStart: { gte: Date; lt: Date } };
    select: Record<string, boolean>;
  };

const today = istKey(new Date());
const daysAgo = (n: number) => istKey(new Date(Date.now() - n * DAY_MS));

describe('DashboardService.getWeeklyActivity', () => {
  it('always returns exactly 7 buckets, oldest → newest, ending today', async () => {
    const { service } = makeService();
    const { data } = await service.getWeeklyActivity();

    expect(data.days).toHaveLength(7);
    expect(data.days[6].date).toBe(today);
    expect(data.days[0].date).toBe(daysAgo(6));

    const dates = data.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates); // ascending
  });

  it('zero-fills days that have no trips', async () => {
    const { service } = makeService([]);
    const { data } = await service.getWeeklyActivity();
    expect(data.days.every((d) => d.value === 0)).toBe(true);
  });

  it('buckets trips onto the correct Asia/Kolkata day', async () => {
    const { service } = makeService([
      istInstant(today, 9),
      istInstant(today, 18),
      istInstant(daysAgo(2), 11),
    ]);
    const { data } = await service.getWeeklyActivity();

    const valueOn = (date: string) =>
      data.days.find((d) => d.date === date)?.value;

    expect(valueOn(today)).toBe(2);
    expect(valueOn(daysAgo(2))).toBe(1);
    expect(valueOn(daysAgo(1))).toBe(0);
  });

  it('respects the IST day boundary, not the UTC one', async () => {
    // 00:30 IST today is 19:00 UTC *yesterday* — it must bucket as today.
    const { service } = makeService([istInstant(today, 0, 30)]);
    const { data } = await service.getWeeklyActivity();

    expect(data.days.find((d) => d.date === today)?.value).toBe(1);
    expect(data.days.find((d) => d.date === daysAgo(1))?.value).toBe(0);
  });

  it('queries a bounded rolling 7-day window covering today', async () => {
    const { service, findMany } = makeService();
    await service.getWeeklyActivity();

    const { where, select } = argsOf(findMany);
    expect(select).toEqual({ scheduledStart: true });

    // Window spans exactly 7 days and ends after "now".
    const span = where.scheduledStart.lt.getTime() - where.scheduledStart.gte.getTime();
    expect(span).toBe(7 * DAY_MS);
    expect(where.scheduledStart.lt.getTime()).toBeGreaterThan(Date.now());
    expect(istKey(where.scheduledStart.gte)).toBe(daysAgo(6));
  });

  it('a trip outside the window never creates an 8th bucket', async () => {
    const { service } = makeService([istInstant(daysAgo(30), 12)]);
    const { data } = await service.getWeeklyActivity();

    expect(data.days).toHaveLength(7);
    expect(data.days.every((d) => d.value === 0)).toBe(true);
  });

  it('ADMIN with no selected client queries fleet-wide (no clientId filter)', async () => {
    const { service, findMany } = makeService();
    await service.getWeeklyActivity(undefined);
    expect(argsOf(findMany).where.clientId).toBeUndefined();
  });

  it('ADMIN with a selected client scopes to that client', async () => {
    const { service, findMany } = makeService();
    await service.getWeeklyActivity('client-A');
    expect(argsOf(findMany).where.clientId).toBe('client-A');
  });

  it('reports the timezone the buckets were computed in', async () => {
    const { service } = makeService();
    const { data } = await service.getWeeklyActivity();
    expect(data.timeZone).toBe('Asia/Kolkata');
  });
});

/**
 * Tenant scoping lives in the controller for every dashboard endpoint (a CLIENT is
 * pinned to req.user.userId before the service is called), so it is asserted there —
 * the service receives an already-resolved id and must simply honour it.
 */
describe('DashboardController weekly-activity scoping', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    DashboardController,
  } = require('./dashboard.controller') as typeof import('./dashboard.controller');

  function makeController() {
    const getWeeklyActivity = jest.fn().mockResolvedValue({ success: true });
    const service: any = { getWeeklyActivity };
    return { controller: new DashboardController(service), getWeeklyActivity };
  }

  it('CLIENT is pinned to its own id and cannot override it via ?clientId', async () => {
    const { controller, getWeeklyActivity } = makeController();
    await controller.getWeeklyActivity(
      { user: { userId: 'client-1', role: 'CLIENT' } } as any,
      'client-OTHER',
    );
    expect(getWeeklyActivity).toHaveBeenCalledWith('client-1');
  });

  it('ADMIN may scope to a selected client', async () => {
    const { controller, getWeeklyActivity } = makeController();
    await controller.getWeeklyActivity(
      { user: { userId: 'admin-1', role: 'ADMIN' } } as any,
      'client-A',
    );
    expect(getWeeklyActivity).toHaveBeenCalledWith('client-A');
  });

  it('ADMIN with no selection stays fleet-wide', async () => {
    const { controller, getWeeklyActivity } = makeController();
    await controller.getWeeklyActivity(
      { user: { userId: 'admin-1', role: 'ADMIN' } } as any,
      undefined,
    );
    expect(getWeeklyActivity).toHaveBeenCalledWith(undefined);
  });
});

/* ------------------------------------------------------------------ */
/* Vehicle status — ONE model shared with /tracking                     */
/* ------------------------------------------------------------------ */

/**
 * The dashboard used to compute status itself from (ignition, speed) with no notion of
 * GPS freshness, so the same vehicle could read OFFLINE on /tracking and MOVING here.
 * These tests pin the dashboard to the status TrackingService persists, and specifically
 * guard the case that exposed the bug: a device dead for weeks, frozen with a non-zero
 * speed, which the old helper reported as MOVING.
 */
describe('DashboardService vehicle status', () => {
  const {
    effectiveVehicleStatus,
  } = require('../common/utils/vehicle-status') as typeof import('../common/utils/vehicle-status');

  /** A vehicle row as TrackingService persists it. */
  const vehicle = (over: Partial<Record<string, any>> = {}) => ({
    id: 'v1',
    vehicleNumber: 'KL00A0000',
    driverName: 'Driver',
    speed: 0,
    ignition: false,
    status: 'IDLE',
    isOnline: true,
    ...over,
  });

  function makeVehicleService(rows: any[]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma: any = { vehicle: { findMany } };
    return { service: new DashboardService(prisma), findMany };
  }

  /* ---- 1-3: the three status cases, read from persisted state ---- */

  it('1. fresh moving vehicle → MOVING', () => {
    expect(
      effectiveVehicleStatus(vehicle({ status: 'MOVING', isOnline: true, speed: 62 })),
    ).toBe('MOVING');
  });

  it('2. fresh stopped vehicle → IDLE', () => {
    expect(
      effectiveVehicleStatus(vehicle({ status: 'IDLE', isOnline: true, speed: 0 })),
    ).toBe('IDLE');
  });

  it('3. stale vehicle that still LOOKS moving → OFFLINE', () => {
    // KL85B1418: 31 days without a fix, frozen at 13.2 km/h with ignition still true.
    // The old helper returned MOVING for exactly this row because speed > 0.
    expect(
      effectiveVehicleStatus(
        vehicle({ status: 'OFFLINE', isOnline: false, speed: 13.2, ignition: true }),
      ),
    ).toBe('OFFLINE');
  });

  it('3b. treats a vehicle as OFFLINE when isOnline and status disagree', () => {
    // The two are written together, so disagreement means one is stale — take the safe
    // reading rather than counting a possibly-stale vehicle as active.
    expect(
      effectiveVehicleStatus(vehicle({ status: 'MOVING', isOnline: false, speed: 40 })),
    ).toBe('OFFLINE');
  });

  it('3c. never reports a status outside the three known values', () => {
    expect(effectiveVehicleStatus(vehicle({ status: 'WEIRD', isOnline: true }))).toBe(
      'OFFLINE',
    );
  });

  /* ---- 4: dashboard counts agree with tracking ---- */

  it('4. stats count by persisted status, matching what /tracking renders', async () => {
    const { service } = makeVehicleService([
      vehicle({ status: 'MOVING', isOnline: true, speed: 62 }),
      vehicle({ status: 'MOVING', isOnline: true, speed: 18 }),
      vehicle({ status: 'IDLE', isOnline: true, speed: 0, ignition: true }),
      // stale but frozen with speed > 0 — the old code counted this as active
      vehicle({ status: 'OFFLINE', isOnline: false, speed: 13.2, ignition: true }),
      vehicle({ status: 'OFFLINE', isOnline: false, speed: 0 }),
    ]);

    const { data } = await service.getDashboardStats();

    expect(data.totalVehicles).toBe(5);
    expect(data.activeVehicles).toBe(2);
    expect(data.idleVehicles).toBe(1);
    expect(data.offlineVehicles).toBe(2);
    // every vehicle lands in exactly one bucket
    expect(data.activeVehicles + data.idleVehicles + data.offlineVehicles).toBe(
      data.totalVehicles,
    );
  });

  it('4b. a stale vehicle with a non-zero speed is NOT counted as active', async () => {
    const { service } = makeVehicleService([
      vehicle({ status: 'OFFLINE', isOnline: false, speed: 13.2, ignition: true }),
    ]);

    const { data } = await service.getDashboardStats();

    expect(data.activeVehicles).toBe(0);
    expect(data.offlineVehicles).toBe(1);
  });

  /* ---- 5: stale vehicles cannot reach the active-vehicles widget ---- */

  it('5. active-vehicles excludes stale rows at the QUERY level', async () => {
    const { service, findMany } = makeVehicleService([]);
    await service.getActiveVehicles();

    const where = findMany.mock.calls[0][0].where;
    expect(where.isOnline).toBe(true);
    expect(where.status).toEqual({ in: ['MOVING', 'IDLE'] });
    // the old engine-state filter is gone — it was what let stale devices through
    expect(where.ignition).toBeUndefined();
  });

  it('5b. active-vehicles returns the persisted status, not a re-derivation', async () => {
    const { service } = makeVehicleService([
      vehicle({ id: 'a', status: 'MOVING', isOnline: true, speed: 55 }),
      // engine on but stopped: the old helper said IDLE via ignition; now it comes
      // from the stored status either way
      vehicle({ id: 'b', status: 'IDLE', isOnline: true, speed: 0, ignition: true }),
    ]);

    const { data } = await service.getActiveVehicles();

    expect(data.map((v: any) => v.status)).toEqual(['MOVING', 'IDLE']);
    expect(data.map((v: any) => v.speed)).toEqual([55, 0]);
  });

  /* ---- 6-7: scoping must be untouched by this change ---- */

  it('6. ADMIN scoping unchanged — fleet-wide with no client, scoped with one', async () => {
    const wide = makeVehicleService([]);
    await wide.service.getDashboardStats();
    expect(wide.findMany.mock.calls[0][0].where).toBeUndefined();

    const scoped = makeVehicleService([]);
    await scoped.service.getDashboardStats('client-A');
    expect(scoped.findMany.mock.calls[0][0].where).toEqual({ clientId: 'client-A' });

    const activeWide = makeVehicleService([]);
    await activeWide.service.getActiveVehicles();
    expect(activeWide.findMany.mock.calls[0][0].where.clientId).toBeUndefined();

    const activeScoped = makeVehicleService([]);
    await activeScoped.service.getActiveVehicles('client-A');
    expect(activeScoped.findMany.mock.calls[0][0].where.clientId).toBe('client-A');
  });

  it('7. CLIENT scoping unchanged — pinned to its own id, cannot override via ?clientId', async () => {
    const {
      DashboardController,
    } = require('./dashboard.controller') as typeof import('./dashboard.controller');

    const getDashboardStats = jest.fn().mockResolvedValue({ success: true });
    const getActiveVehicles = jest.fn().mockResolvedValue({ success: true });
    const controller = new DashboardController({
      getDashboardStats,
      getActiveVehicles,
    } as any);

    await controller.getDashboardStats(
      { user: { userId: 'client-1', role: 'CLIENT' } } as any,
      'client-OTHER',
    );
    expect(getDashboardStats).toHaveBeenCalledWith('client-1');

    await controller.getActiveVehicles(
      { user: { userId: 'client-1', role: 'CLIENT' } } as any,
      'client-OTHER',
    );
    expect(getActiveVehicles).toHaveBeenCalledWith('client-1');
  });
});
