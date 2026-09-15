import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, TripStatus } from '@prisma/client';
import { TripsService } from './trips.service';

/**
 * Security guard: a CLIENT must not attach a vehicle it does not own to a trip —
 * that would leak the vehicle's live position/ETA/breadcrumbs through the trip read
 * endpoints (e.g. GET /trips/:id/progress). Only the reject path is exercised: it is
 * the assertion that fails if assertOwnedVehicle is ever dropped from create()/update().
 */
function makeService(ownedVehicle: any, trip?: any) {
  const prisma: any = {
    vehicle: { findFirst: jest.fn().mockResolvedValue(ownedVehicle) },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: 'cust' }) },
    trip: { findUnique: jest.fn().mockResolvedValue(trip ?? null) },
  };
  // geocoding + notifications are never reached on the reject path.
  return new TripsService(prisma, {} as any, {} as any);
}

const user = { userId: 'client-1', role: 'CLIENT' } as any;

describe('TripsService vehicle-ownership guard', () => {
  it('create rejects a vehicle the client does not own (400 INVALID_VEHICLE)', async () => {
    const service = makeService(null); // {id, clientId} finds nothing → not owned
    await expect(
      service.create(user, { vehicleId: 'v-other' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update rejects re-linking a vehicle the client does not own', async () => {
    const service = makeService(null, { id: 't1', clientId: 'client-1' });
    await expect(
      service.update(user, 't1', { vehicleId: 'v-other' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ================================================================ */
/* ADMIN direct trip creation (Slice A) — owner resolution + reuse   */
/* ================================================================ */

/**
 * A fuller create harness: a real TripsService over a mocked Prisma + geocoding, so
 * create() genuinely runs owner resolution + the existing ownership/overlap checks + the
 * persist. Ownership is driven by customer/vehicle findFirst (a row = owned, null = not),
 * the target client by client.findUnique, and overlap by trip.findMany. Coords are
 * supplied on the dto so geocoding is never needed.
 */
function makeCreateService(opts: any = {}) {
  const prisma: any = {
    client: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          'client' in opts ? opts.client : { id: 'client-A', name: 'Client A' },
        ),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Admin One' }) },
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue('customer' in opts ? opts.customer : { id: 'cust-1' }),
    },
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue('vehicle' in opts ? opts.vehicle : { id: 'veh-1' }),
    },
    trip: {
      findMany: jest.fn().mockResolvedValue(opts.overlap ?? []),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'trip-1', ...data, stops: [] }),
        ),
    },
  };
  const geocoding = { geocode: jest.fn().mockResolvedValue({ lat: 0, lng: 0 }) };
  const notifications = { onTripStatusChanged: jest.fn() };
  const service = new TripsService(
    prisma,
    geocoding as any,
    notifications as any,
  );
  return { service, prisma };
}

const adminUser = { userId: 'admin-1', role: 'ADMIN' } as any;
const clientUser = { userId: 'client-1', role: 'CLIENT' } as any;

const createDto = (over: any = {}) =>
  ({
    clientId: 'client-A',
    vehicleId: 'veh-1',
    driverId: 'drv:john',
    // An ADMIN direct create requires both driver fields (see requireAdminDriver).
    driverName: 'John',
    driverPhone: '+91 98765 43210',
    customerId: 'cust-1',
    origin: 'Kochi',
    destination: 'Calicut',
    originLat: 9.93,
    originLng: 76.26,
    destinationLat: 11.25,
    destinationLng: 75.78,
    scheduledStart: '2026-09-01T08:00:00.000Z',
    scheduledEnd: '2026-09-01T12:00:00.000Z',
    ...over,
  }) as any;

describe('TripsService.create — ADMIN direct creation', () => {
  it('creates a Trip for the selected client (owner = dto.clientId)', async () => {
    const { service, prisma } = makeCreateService();
    const res = await service.create(adminUser, createDto());
    expect(res.success).toBe(true);
    expect(prisma.trip.create).toHaveBeenCalledTimes(1);
    const data = prisma.trip.create.mock.calls[0][0].data;
    expect(data.clientId).toBe('client-A');
    // Vehicle + driver present → normal lifecycle preserved (ASSIGNED).
    expect(data.status).toBe('ASSIGNED');
  });

  it('rejects a missing clientId with a clean 400 (no Trip, no FK failure)', async () => {
    const { service, prisma } = makeCreateService();
    await expect(
      service.create(adminUser, createDto({ clientId: undefined })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown clientId with a clean 400 (INVALID_CLIENT)', async () => {
    const { service, prisma } = makeCreateService({ client: null });
    await expect(service.create(adminUser, createDto())).rejects.toMatchObject({
      message: 'INVALID_CLIENT',
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it("rejects a vehicle belonging to another client (INVALID_VEHICLE)", async () => {
    const { service, prisma } = makeCreateService({ vehicle: null });
    await expect(service.create(adminUser, createDto())).rejects.toMatchObject({
      message: 'INVALID_VEHICLE',
    });
    // Ownership was checked against the SELECTED client, not the admin.
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      where: { id: 'veh-1', clientId: 'client-A' },
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it("rejects a customer belonging to another client (INVALID_CUSTOMER)", async () => {
    const { service, prisma } = makeCreateService({ customer: null });
    await expect(service.create(adminUser, createDto())).rejects.toMatchObject({
      message: 'INVALID_CUSTOMER',
    });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'cust-1', clientId: 'client-A' },
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('scopes overlap validation to the selected client', async () => {
    const { service, prisma } = makeCreateService({
      overlap: [{ id: 't-x', reference: 'TRIP-X' }],
    });
    await expect(service.create(adminUser, createDto())).rejects.toMatchObject({
      message: 'VEHICLE_OVERLAP',
    });
    expect(prisma.trip.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-A',
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });
});

describe('TripsService.create — CLIENT behavior unchanged', () => {
  it('owns the trip via the JWT and ignores any body clientId', async () => {
    const { service, prisma } = makeCreateService();
    const res = await service.create(
      clientUser,
      createDto({ clientId: 'attacker-client' }),
    );
    expect(res.success).toBe(true);
    const data = prisma.trip.create.mock.calls[0][0].data;
    // Owner is the authenticated client, NOT the body clientId.
    expect(data.clientId).toBe('client-1');
    // Ownership checks used the JWT client too (no cross-client escalation).
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      where: { id: 'veh-1', clientId: 'client-1' },
    });
  });
});

/* ================================================================ */
/* Slice B — option access (drivers + overlap) for ADMIN            */
/* ================================================================ */

/** listDrivers harness: vehicle.findMany drives the result; client.findUnique echoes the
 *  queried id (or a forced value) for the ADMIN target-client validation. */
function makeDriversService(opts: any = {}) {
  const prisma: any = {
    client: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            'client' in opts ? opts.client : where?.id ? { id: where.id } : null,
          ),
        ),
    },
    vehicle: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.vehicles ?? [{ driverName: 'John' }, { driverName: 'Jane' }],
        ),
    },
  };
  return { service: new TripsService(prisma, {} as any, {} as any), prisma };
}

describe('TripsService.listDrivers — Slice B option access', () => {
  it('ADMIN + clientId A → only that client’s vehicles are scanned', async () => {
    const { service, prisma } = makeDriversService();
    await service.listDrivers(adminUser, 'client-A');
    expect(prisma.vehicle.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-A',
    );
  });

  it('ADMIN + clientId B → scoped to client B', async () => {
    const { service, prisma } = makeDriversService();
    await service.listDrivers(adminUser, 'client-B');
    expect(prisma.vehicle.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-B',
    );
  });

  it('CLIENT → own drivers only (JWT-scoped)', async () => {
    const { service, prisma } = makeDriversService();
    await service.listDrivers(clientUser, undefined);
    expect(prisma.vehicle.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-1',
    );
  });

  it('CLIENT cannot override the scope via a clientId query param', async () => {
    const { service, prisma } = makeDriversService();
    await service.listDrivers(clientUser, 'other-client');
    expect(prisma.vehicle.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-1',
    );
    // A CLIENT never triggers the ADMIN target-client lookup.
    expect(prisma.client.findUnique).not.toHaveBeenCalled();
  });

  it('ADMIN missing clientId → clean 400, no vehicle scan', async () => {
    const { service, prisma } = makeDriversService();
    await expect(
      service.listDrivers(adminUser, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
  });

  it('ADMIN unknown clientId → clean 400 (INVALID_CLIENT)', async () => {
    const { service, prisma } = makeDriversService({ client: null });
    await expect(service.listDrivers(adminUser, 'ghost')).rejects.toMatchObject({
      message: 'INVALID_CLIENT',
    });
    expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
  });
});

/** checkOverlap harness: trip.findMany returns the (mock) conflicts. */
function makeOverlapService(conflicts: any[] = []) {
  const prisma: any = { trip: { findMany: jest.fn().mockResolvedValue(conflicts) } };
  return { service: new TripsService(prisma, {} as any, {} as any), prisma };
}

const overlapQuery = (over: any = {}) => ({
  vehicleId: 'veh-1',
  start: '2026-09-01T08:00:00.000Z',
  end: '2026-09-01T12:00:00.000Z',
  ...over,
});

describe('TripsService.checkOverlap — Slice B option access', () => {
  it('ADMIN overlap is scoped to the selected client', async () => {
    const { service, prisma } = makeOverlapService([{ id: 't-x' }]);
    const res = await service.checkOverlap(
      adminUser,
      overlapQuery({ clientId: 'client-A' }) as any,
    );
    expect(res.hasOverlap).toBe(true);
    expect(prisma.trip.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-A',
    );
  });

  it('CLIENT overlap remains JWT-scoped', async () => {
    const { service, prisma } = makeOverlapService([]);
    await service.checkOverlap(clientUser, overlapQuery() as any);
    expect(prisma.trip.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-1',
    );
  });

  it('CLIENT cannot override the scope via a clientId query param', async () => {
    const { service, prisma } = makeOverlapService([]);
    await service.checkOverlap(
      clientUser,
      overlapQuery({ clientId: 'other-client' }) as any,
    );
    expect(prisma.trip.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-1',
    );
  });

  it('ADMIN with no selected client does not scan across clients', async () => {
    const { service, prisma } = makeOverlapService([{ id: 't-x' }]);
    const res = await service.checkOverlap(adminUser, overlapQuery() as any);
    expect(res.hasOverlap).toBe(false);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });
});


/* ================================================================ */
/* findAll — optional server-side status filter (Batch 4)            */
/* ================================================================ */

/**
 * findAll harness: trip.findMany drives the result. These assert on the `where` handed
 * to Prisma, which is the whole point of the feature — the status condition must reach
 * the query so the database returns only the matching rows, never a full fetch filtered
 * in memory. Tenant scoping is asserted alongside it so the filter can't quietly widen it.
 */
function makeFindAllService(trips: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(trips);
  const prisma: any = { trip: { findMany } };
  return {
    service: new TripsService(prisma, {} as any, {} as any),
    findMany,
  };
}

/** The `where` handed to prisma.trip.findMany on the first call. */
function whereOf(findMany: jest.Mock): Prisma.TripWhereInput {
  const args = findMany.mock.calls[0][0] as { where: Prisma.TripWhereInput };
  return args.where;
}

const findAllAdmin = { userId: 'admin-1', role: 'ADMIN' };
const findAllClient = { userId: 'client-1', role: 'CLIENT' };

describe('TripsService.findAll — status filter', () => {
  it('no status → no status condition (existing behaviour unchanged)', async () => {
    const { service, findMany } = makeFindAllService();
    await service.findAll(findAllAdmin);
    expect(whereOf(findMany).status).toBeUndefined();
  });

  it('passes the status condition to Prisma rather than filtering in memory', async () => {
    const { service, findMany } = makeFindAllService();
    await service.findAll(findAllAdmin, undefined, [TripStatus.ONGOING]);
    expect(whereOf(findMany).status).toEqual({ in: [TripStatus.ONGOING] });
  });

  it('supports the multi-status set the dashboard asks for', async () => {
    const { service, findMany } = makeFindAllService();
    const active = [TripStatus.STARTED, TripStatus.ONGOING, TripStatus.DELAYED];
    await service.findAll(findAllAdmin, undefined, active);
    expect(whereOf(findMany).status).toEqual({ in: active });
  });

  it('an empty status list is treated as no filter', async () => {
    const { service, findMany } = makeFindAllService();
    await service.findAll(findAllAdmin, undefined, []);
    expect(whereOf(findMany).status).toBeUndefined();
  });

  it('CLIENT stays pinned to its own trips when filtering', async () => {
    const { service, findMany } = makeFindAllService();
    await service.findAll(findAllClient, 'other-client', [TripStatus.ONGOING]);
    expect(whereOf(findMany).clientId).toBe('client-1');
    expect(whereOf(findMany).status).toEqual({ in: [TripStatus.ONGOING] });
  });

  it('ADMIN clientId scoping still applies alongside the filter', async () => {
    const { service, findMany } = makeFindAllService();
    await service.findAll(findAllAdmin, 'client-A', [TripStatus.ASSIGNED]);
    expect(whereOf(findMany).clientId).toBe('client-A');
    expect(whereOf(findMany).status).toEqual({ in: [TripStatus.ASSIGNED] });
  });
});
