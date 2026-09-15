import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TripRequestsService } from './trip-requests.service';
import { TripRequestsController } from './trip-requests.controller';
import { TripsController } from '../trips/trips.controller';
import { TripsService } from '../trips/trips.service';
import { RolesGuard } from '../auth/roles.guard';
import { CreateTripDto } from '../trips/dto/create-trip.dto';

/**
 * Slice 1 — request creation + ownership-scoped reads. A real TripsService (for its
 * ownership checks) runs over a mocked Prisma that the request service shares; ownership
 * is driven by what customer/vehicle findFirst return (a row = owned, null = not owned).
 * No Trip is ever created in Slice 1 (prisma.trip.create must stay untouched).
 */
function makeService(
  opts: { customer?: any; vehicle?: any; found?: any; list?: any[] } = {},
) {
  const prisma: any = {
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue('customer' in opts ? opts.customer : { id: 'cust' }),
    },
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue('vehicle' in opts ? opts.vehicle : { id: 'veh' }),
    },
    tripRequest: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'req1', ...data }),
        ),
      findMany: jest.fn().mockResolvedValue(opts.list ?? []),
      findUnique: jest.fn().mockResolvedValue(opts.found ?? null),
    },
    trip: { create: jest.fn() }, // must NEVER be called in Slice 1
  };
  const notifications = {
    onTripRequested: jest.fn().mockResolvedValue({ id: 'n1' }),
    onTripRequestApproved: jest.fn().mockResolvedValue({ id: 'n2' }),
    onTripRequestRejected: jest.fn().mockResolvedValue({ id: 'n3' }),
  };
  const trips = new TripsService(prisma, {} as any, notifications as any);
  const service = new TripRequestsService(prisma, trips, notifications as any);
  return { service, prisma, notifications };
}

const clientUser = { userId: 'client-1', role: 'CLIENT' } as any;
const adminUser = { userId: 'admin-1', role: 'ADMIN' } as any;

/** Driver the ADMIN supplies in the approval modal — required on every approve. */
const APPROVE_DRIVER = { driverName: 'Ravi Kumar', driverPhone: '+91 98765 43210' };

const baseDto = (over: Partial<CreateTripDto> = {}): CreateTripDto =>
  ({
    vehicleId: 'veh-1',
    driverId: 'drv:john',
    driverName: 'John',
    customerId: 'cust-1',
    origin: 'A',
    destination: 'B',
    scheduledStart: '2026-09-01T08:00:00.000Z',
    scheduledEnd: '2026-09-01T12:00:00.000Z',
    ...over,
  }) as CreateTripDto;

describe('TripRequestsService.create', () => {
  it('creates a PENDING request and does NOT create a Trip', async () => {
    const { service, prisma } = makeService();
    const res = await service.create(clientUser, baseDto());
    expect(res.success).toBe(true);
    expect(res.request.status).toBe('PENDING');
    expect(prisma.tripRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('derives clientId from the JWT, ignoring any clientId in the body', async () => {
    const { service, prisma } = makeService();
    await service.create(
      clientUser,
      baseDto({ clientId: 'attacker-client' } as any),
    );
    expect(prisma.tripRequest.create.mock.calls[0][0].data.clientId).toBe(
      'client-1',
    );
  });

  it('rejects a vehicle the client does not own (no request persisted)', async () => {
    const { service, prisma } = makeService({ vehicle: null });
    await expect(service.create(clientUser, baseDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tripRequest.create).not.toHaveBeenCalled();
  });

  it('rejects a customer the client does not own (no request persisted)', async () => {
    const { service, prisma } = makeService({ customer: null });
    await expect(service.create(clientUser, baseDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tripRequest.create).not.toHaveBeenCalled();
  });

  it('defaults the persisted status to PENDING', async () => {
    const { service, prisma } = makeService();
    await service.create(clientUser, baseDto());
    expect(prisma.tripRequest.create.mock.calls[0][0].data.status).toBe(
      'PENDING',
    );
  });
});

describe('TripRequestsService reads', () => {
  it('scopes a CLIENT list to its own requests (cannot list all like an admin)', async () => {
    const { service, prisma } = makeService();
    await service.findAll(clientUser);
    expect(prisma.tripRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'client-1' } }),
    );
  });

  it('lets an ADMIN list all requests (unscoped)', async () => {
    const { service, prisma } = makeService();
    await service.findAll(adminUser);
    expect(prisma.tripRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it("forbids a CLIENT from reading another client's request", async () => {
    const { service } = makeService({
      found: { id: 'req1', clientId: 'other-client' },
    });
    await expect(service.findOne(clientUser, 'req1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets an ADMIN read any request', async () => {
    const { service } = makeService({
      found: { id: 'req1', clientId: 'other-client' },
    });
    const res = await service.findOne(adminUser, 'req1');
    expect(res.success).toBe(true);
  });

  it('404s an unknown request', async () => {
    const { service } = makeService({ found: null });
    await expect(service.findOne(clientUser, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('request payload validation (reused CreateTripDto rules)', () => {
  it('rejects a payload missing the required trip fields', async () => {
    const dto = plainToInstance(CreateTripDto, {});
    const invalid = new Set((await validate(dto)).map((e) => e.property));
    expect(invalid.has('origin')).toBe(true);
    expect(invalid.has('destination')).toBe(true);
    expect(invalid.has('scheduledStart')).toBe(true);
    expect(invalid.has('scheduledEnd')).toBe(true);
  });
});

/* ================================================================ */
/* Slice 2 — approve / reject                                        */
/* ================================================================ */

/**
 * A fuller harness for approval/rejection: a real TripsService (so approval genuinely
 * re-runs ownership + overlap revalidation + create) over a mocked Prisma + geocoding,
 * plus a mocked NotificationsService whose triggers we assert on. Ownership is driven by
 * customer/vehicle findFirst (a row = owned, null = not owned); overlap by trip.findMany;
 * the atomic claim by tripRequest.updateMany's `count`. Request coords are supplied so
 * trips.create never needs geocoding.
 */
function makeApproval(opts: any = {}) {
  const request = {
    id: 'req1',
    status: 'PENDING',
    clientId: 'client-1',
    reference: null,
    vehicleId: 'veh-1',
    driverId: 'drv:john',
    driverName: 'John',
    customerId: 'cust-1',
    origin: 'Kochi',
    destination: 'Calicut',
    originLat: 9.93,
    originLng: 76.26,
    destinationLat: 11.25,
    destinationLng: 75.78,
    stops: null,
    distanceKm: 180,
    durationMins: 240,
    notes: null,
    scheduledStart: new Date('2026-09-01T08:00:00.000Z'),
    scheduledEnd: new Date('2026-09-01T12:00:00.000Z'),
    tripId: null,
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    ...(opts.request ?? {}),
  };

  const prisma: any = {
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
    client: { findUnique: jest.fn().mockResolvedValue({ name: 'Client One' }) },
    trip: {
      findMany: jest.fn().mockResolvedValue(opts.overlap ?? []),
      create:
        opts.tripCreate ??
        jest
          .fn()
          .mockImplementation(({ data }: any) =>
            Promise.resolve({ id: 'trip-99', ...data, stops: [] }),
          ),
    },
    tripRequest: {
      findUnique: jest.fn().mockResolvedValue(request),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      update: opts.updateFail
        ? jest.fn().mockRejectedValue(new Error('meta write failed'))
        : jest
            .fn()
            .mockImplementation(({ data }: any) =>
              Promise.resolve({ ...request, status: 'APPROVED', ...data }),
            ),
    },
  };
  const geocoding = { geocode: jest.fn().mockResolvedValue({ lat: 0, lng: 0 }) };
  const notifications = {
    onTripRequested: jest.fn().mockResolvedValue({ id: 'n1' }),
    onTripRequestApproved: jest.fn().mockResolvedValue({ id: 'n2' }),
    onTripRequestRejected: jest.fn().mockResolvedValue({ id: 'n3' }),
  };
  const trips = new TripsService(prisma, geocoding as any, notifications as any);
  const service = new TripRequestsService(prisma, trips, notifications as any);
  return { service, prisma, notifications, request };
}

/** A fake ExecutionContext targeting one controller handler, for the RolesGuard. */
function guardCtx(handler: any, user: any) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => TripRequestsController,
  } as any;
}

describe('create() fires the TRIP_REQUESTED admin notification', () => {
  it('notifies the ADMIN audience when a request is created', async () => {
    const { service, notifications } = makeService();
    await service.create(clientUser, baseDto());
    expect(notifications.onTripRequested).toHaveBeenCalledTimes(1);
    expect(notifications.onTripRequested.mock.calls[0][0]).toEqual(
      expect.objectContaining({ clientId: 'client-1' }),
    );
    // No client-facing approval/rejection notification on mere creation.
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
    expect(notifications.onTripRequestRejected).not.toHaveBeenCalled();
  });
});

describe('TripRequestsService.approve', () => {
  it('lets an ADMIN approve a PENDING request', async () => {
    const { service } = makeApproval();
    const res = await service.approve(adminUser, 'req1', APPROVE_DRIVER);
    expect(res.success).toBe(true);
    expect(res.request.status).toBe('APPROVED');
  });

  it('forbids a CLIENT from approving (approve route is ADMIN-only)', () => {
    const guard = new RolesGuard(new Reflector());
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.approve, { role: 'CLIENT' }),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.approve, { role: 'ADMIN' }),
      ),
    ).toBe(true);
  });

  it('cannot approve an already-APPROVED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'APPROVED' } });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('cannot approve a REJECTED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'REJECTED' } });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('creates exactly one Trip', async () => {
    const { service, prisma } = makeApproval();
    await service.approve(adminUser, 'req1', APPROVE_DRIVER);
    expect(prisma.trip.create).toHaveBeenCalledTimes(1);
  });

  it('creates the Trip in ASSIGNED status (vehicle + driver present)', async () => {
    const { service, prisma } = makeApproval();
    await service.approve(adminUser, 'req1', APPROVE_DRIVER);
    expect(prisma.trip.create.mock.calls[0][0].data.status).toBe('ASSIGNED');
  });

  it('stores the created tripId on the request', async () => {
    const { service, prisma } = makeApproval();
    const res = await service.approve(adminUser, 'req1', APPROVE_DRIVER);
    expect(prisma.tripRequest.update.mock.calls[0][0].data.tripId).toBe(
      'trip-99',
    );
    expect(res.request.tripId).toBe('trip-99');
  });

  it('stores the reviewer id and review timestamp', async () => {
    const { service, prisma } = makeApproval();
    await service.approve(adminUser, 'req1', APPROVE_DRIVER);
    const data = prisma.tripRequest.update.mock.calls[0][0].data;
    expect(data.reviewedById).toBe('admin-1');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it('revalidates vehicle ownership against current state (rolls back if not owned)', async () => {
    const { service, prisma } = makeApproval({ vehicle: null });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Ownership was checked with the OWNING client, not the admin.
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      where: { id: 'veh-1', clientId: 'client-1' },
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    // Claim rolled back APPROVED → PENDING.
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('revalidates customer ownership against current state (rolls back if not owned)', async () => {
    const { service, prisma } = makeApproval({ customer: null });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'cust-1', clientId: 'client-1' },
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('revalidates vehicle overlap (rolls back on a new double-booking)', async () => {
    const { service, prisma } = makeApproval({
      overlap: [{ tripId: 't-x', reference: 'TRIP-X' }],
    });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toMatchObject({
      message: 'VEHICLE_OVERLAP',
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('revalidates driver overlap (rolls back on a new double-booking)', async () => {
    const { service, prisma } = makeApproval({
      request: { vehicleId: null }, // isolate the driver overlap check
      overlap: [{ tripId: 't-y', reference: 'TRIP-Y' }],
    });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toMatchObject({
      message: 'DRIVER_OVERLAP',
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('rolls the request back to PENDING when Trip creation fails', async () => {
    const { service, prisma, notifications } = makeApproval({
      tripCreate: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toThrow('db down');
    expect(prisma.tripRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
    // No approval notification when no Trip was created.
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
  });

  it('does NOT roll back to PENDING when metadata persistence fails AFTER Trip creation', async () => {
    const { service, prisma, notifications } = makeApproval({ updateFail: true });
    // The metadata write throws, and that error surfaces to the caller.
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toThrow(
      'meta write failed',
    );
    // The Trip was created exactly once.
    expect(prisma.trip.create).toHaveBeenCalledTimes(1);
    // The ONLY updateMany was the APPROVED claim — there is NO revert-to-PENDING call.
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.tripRequest.updateMany.mock.calls[0][0].data).toEqual({
      status: 'APPROVED',
    });
    const revertedToPending = prisma.tripRequest.updateMany.mock.calls.some(
      (c: any[]) => c[0]?.data?.status === 'PENDING',
    );
    expect(revertedToPending).toBe(false);
    // Best-effort notification never fired (the error was thrown before it).
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
  });

  it('a re-approval after a metadata failure cannot create a duplicate Trip (request stays APPROVED)', async () => {
    // After the metadata-write failure the row is APPROVED in the DB. A retry sees APPROVED
    // and 409s WITHOUT creating a second Trip — the duplicate-Trip invariant holds.
    const { service, prisma } = makeApproval({ request: { status: 'APPROVED' } });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('a losing concurrent approval (claim count 0) creates no Trip and 409s', async () => {
    const { service, prisma, notifications } = makeApproval({ claimCount: 0 });
    await expect(service.approve(adminUser, 'req1', APPROVE_DRIVER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
  });

  it('notifies the requesting CLIENT only after the Trip is created', async () => {
    const { service, notifications } = makeApproval();
    await service.approve(adminUser, 'req1', APPROVE_DRIVER);
    expect(notifications.onTripRequestApproved).toHaveBeenCalledTimes(1);
    const [reqArg, tripIdArg] =
      notifications.onTripRequestApproved.mock.calls[0];
    expect(reqArg.clientId).toBe('client-1');
    expect(tripIdArg).toBe('trip-99');
  });
});

describe('TripRequestsService.reject', () => {
  it('lets an ADMIN reject a PENDING request', async () => {
    const { service, prisma } = makeApproval();
    const res = await service.reject(adminUser, 'req1', 'No capacity');
    expect(res.success).toBe(true);
    expect(prisma.tripRequest.updateMany.mock.calls[0][0].data.status).toBe(
      'REJECTED',
    );
  });

  it('forbids a CLIENT from rejecting (reject route is ADMIN-only)', () => {
    const guard = new RolesGuard(new Reflector());
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.reject, { role: 'CLIENT' }),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.reject, { role: 'ADMIN' }),
      ),
    ).toBe(true);
  });

  it('rejects a missing reason (no claim written)', async () => {
    const { service, prisma } = makeApproval();
    await expect(
      service.reject(adminUser, 'req1', undefined as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only reason (no claim written)', async () => {
    const { service, prisma } = makeApproval();
    await expect(service.reject(adminUser, 'req1', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('stores the trimmed reason, reviewer id and timestamp', async () => {
    const { service, prisma } = makeApproval();
    await service.reject(adminUser, 'req1', '  No capacity  ');
    const data = prisma.tripRequest.updateMany.mock.calls[0][0].data;
    expect(data.rejectionReason).toBe('No capacity');
    expect(data.reviewedById).toBe('admin-1');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it('creates no Trip on rejection', async () => {
    const { service, prisma } = makeApproval();
    await service.reject(adminUser, 'req1', 'No capacity');
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('cannot reject an already-APPROVED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'APPROVED' } });
    await expect(
      service.reject(adminUser, 'req1', 'too late'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('cannot reject an already-REJECTED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'REJECTED' } });
    await expect(
      service.reject(adminUser, 'req1', 'again'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('notifies the requesting CLIENT of the rejection', async () => {
    const { service, notifications } = makeApproval();
    await service.reject(adminUser, 'req1', 'No capacity');
    expect(notifications.onTripRequestRejected).toHaveBeenCalledTimes(1);
    expect(notifications.onTripRequestRejected.mock.calls[0][0]).toEqual(
      expect.objectContaining({ clientId: 'client-1', rejectionReason: 'No capacity' }),
    );
  });
});

/* ================================================================ */
/* Driver flow, vehicle resolution and delete                        */
/* ================================================================ */

/**
 * Harness for the read/delete paths. Separate from makeService() above so the existing
 * approve tests keep their exact mock surface; this one adds the vehicle lookup that
 * withReferences() performs and the delete the new endpoint needs.
 */
function makeReadService(opts: any = {}) {
  const prisma: any = {
    tripRequest: {
      findMany: jest.fn().mockResolvedValue(opts.requests ?? []),
      findUnique: jest.fn().mockResolvedValue(opts.request ?? null),
      delete: jest.fn().mockResolvedValue({ id: 'req1' }),
    },
    trip: {
      // count 0 models a tripId pointing at an already-deleted Trip.
      deleteMany: jest.fn().mockResolvedValue({ count: opts.tripCount ?? 1 }),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue(opts.vehicles ?? []),
    },
  };
  // Interactive $transaction: the callback gets a client. Handing it the same mock lets a
  // test assert on prisma.* while still proving both writes ran inside the one call. When
  // opts.txFails is set the callback's work is discarded, standing in for a rollback.
  prisma.$transaction = jest.fn(async (fn: any) => {
    const result = await fn(prisma);
    if (opts.txFails) throw new Error('transaction rolled back');
    return result;
  });
  const service = new TripRequestsService(prisma, {} as any, {} as any);
  return { service, prisma };
}

const VEHICLE = {
  id: 'veh-1',
  vehicleNumber: 'KL84D1577',
  vehicleName: 'Tata Ace',
};

describe('TripRequest driver flow', () => {
  it('create() ignores any driver a CLIENT tries to send', async () => {
    const { service, prisma } = makeService();
    await service.create(clientUser, {
      ...baseDto(),
      driverId: 'drv-x',
      driverName: 'Client Supplied',
      driverPhone: '+91 00000 00000',
    } as any);

    const data = prisma.tripRequest.create.mock.calls[0][0].data;
    expect(data.driverId).toBeNull();
    expect(data.driverName).toBeNull();
    expect(data.driverPhone).toBeNull();
  });

  it('approve() rejects a missing driver name', async () => {
    const { service } = makeService();
    await expect(
      service.approve(adminUser, 'req1', {
        driverName: '   ',
        driverPhone: '+91 98765 43210',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('approve() rejects a missing driver phone', async () => {
    const { service } = makeService();
    await expect(
      service.approve(adminUser, 'req1', {
        driverName: 'Ravi Kumar',
        driverPhone: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('approve() saves the driver onto the Trip and back onto the request', async () => {
    const { service, prisma } = makeApproval();
    await service.approve(adminUser, 'req1', APPROVE_DRIVER);

    const tripData = prisma.trip.create.mock.calls[0][0].data;
    expect(tripData.driverName).toBe('Ravi Kumar');
    expect(tripData.driverPhone).toBe('+91 98765 43210');

    const reqData = prisma.tripRequest.update.mock.calls[0][0].data;
    expect(reqData.driverName).toBe('Ravi Kumar');
    expect(reqData.driverPhone).toBe('+91 98765 43210');
  });

  it('an ADMIN direct create with a name but no phone is refused', async () => {
    const { service } = makeApproval();
    const trips = (service as any).trips as TripsService;
    await expect(
      trips.create({ userId: 'admin-1', role: 'ADMIN' } as any, {
        ...baseDto(),
        clientId: 'client-1',
        driverName: 'Ravi Kumar',
      } as any),
    ).rejects.toMatchObject({ message: 'DRIVER_PHONE_REQUIRED' });
  });

  it('an ADMIN direct create requires a driver name', async () => {
    const { service } = makeApproval();
    const trips = (service as any).trips as TripsService;
    await expect(
      trips.create({ userId: 'admin-1', role: 'ADMIN' } as any, {
        ...baseDto(),
        clientId: 'client-1',
        driverName: '   ', // whitespace-only must count as missing
        driverPhone: '+91 98765 43210',
      } as any),
    ).rejects.toMatchObject({ message: 'DRIVER_NAME_REQUIRED' });
  });

  it('a CLIENT trip request needs no driver at all', async () => {
    const { service } = makeService();
    await expect(service.create(clientUser, baseDto())).resolves.toMatchObject({
      success: true,
    });
  });
});

describe('TripRequest vehicle resolution', () => {
  it('findOne attaches the assigned vehicle with its number', async () => {
    const { service, prisma } = makeReadService({
      request: { id: 'req1', clientId: 'client-1', vehicleId: 'veh-1' },
      vehicles: [VEHICLE],
    });

    const { request } = await service.findOne(adminUser, 'req1');
    expect(request.vehicle).toEqual(VEHICLE);
    expect(request.vehicle?.vehicleNumber).toBe('KL84D1577');
    expect(prisma.vehicle.findMany).toHaveBeenCalledTimes(1);
  });

  it('findAll attaches vehicles in ONE batched lookup (no N+1)', async () => {
    const { service, prisma } = makeReadService({
      requests: [
        { id: 'r1', clientId: 'client-1', vehicleId: 'veh-1' },
        { id: 'r2', clientId: 'client-1', vehicleId: 'veh-1' },
        { id: 'r3', clientId: 'client-1', vehicleId: null },
      ],
      vehicles: [VEHICLE],
    });

    const { requests } = await service.findAll(adminUser);
    expect(prisma.vehicle.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.findMany.mock.calls[0][0].where.id.in).toEqual([
      'veh-1',
    ]);
    expect(requests[0].vehicle?.vehicleNumber).toBe('KL84D1577');
    expect(requests[1].vehicle?.vehicleNumber).toBe('KL84D1577');
    expect(requests[2].vehicle).toBeNull();
  });

  it('skips the vehicle query entirely when no request has a vehicle', async () => {
    const { service, prisma } = makeReadService({
      requests: [{ id: 'r1', clientId: 'client-1', vehicleId: null }],
    });
    await service.findAll(adminUser);
    expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
  });
});

/** A request row as stored; `tripId` is set only once an ADMIN has approved it. */
const pendingRequest = (over: any = {}) => ({
  id: 'req1',
  clientId: 'client-1',
  status: 'PENDING',
  tripId: null,
  ...over,
});
const approvedRequest = (over: any = {}) =>
  pendingRequest({ status: 'APPROVED', tripId: 'trip-99', ...over });

describe('TripRequestsService.remove', () => {
  it('lets an ADMIN delete a PENDING request', async () => {
    const { service, prisma } = makeReadService({ request: pendingRequest() });
    await expect(service.remove(adminUser, 'req1')).resolves.toEqual({
      success: true,
    });
    expect(prisma.tripRequest.delete).toHaveBeenCalledWith({
      where: { id: 'req1' },
    });
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
  });

  it('lets a CLIENT delete its OWN PENDING request', async () => {
    const { service, prisma } = makeReadService({ request: pendingRequest() });
    await service.remove(clientUser, 'req1');
    expect(prisma.tripRequest.delete).toHaveBeenCalled();
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes a REJECTED request (no Trip) the same way', async () => {
    const { service, prisma } = makeReadService({
      request: pendingRequest({ status: 'REJECTED' }),
    });
    await service.remove(clientUser, 'req1');
    expect(prisma.tripRequest.delete).toHaveBeenCalled();
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a CLIENT deleting a request owned by another client', async () => {
    const { service, prisma } = makeReadService({
      request: pendingRequest({ clientId: 'client-OTHER' }),
    });
    await expect(service.remove(clientUser, 'req1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.tripRequest.delete).not.toHaveBeenCalled();
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a CLIENT deleting ANOTHER client’s APPROVED request — the Trip survives', async () => {
    const { service, prisma } = makeReadService({
      request: approvedRequest({ clientId: 'client-OTHER' }),
    });
    await expect(service.remove(clientUser, 'req1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
  });

  it('404s an unknown request', async () => {
    const { service } = makeReadService({ request: null });
    await expect(service.remove(adminUser, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /* ---- an approved request owns its Trip: both go, or neither does ---- */

  it('a CLIENT deleting its own APPROVED request deletes the linked Trip too', async () => {
    const { service, prisma } = makeReadService({ request: approvedRequest() });

    await expect(service.remove(clientUser, 'req1')).resolves.toEqual({
      success: true,
    });
    expect(prisma.trip.deleteMany).toHaveBeenCalledWith({
      where: { id: 'trip-99' },
    });
    expect(prisma.tripRequest.delete).toHaveBeenCalledWith({
      where: { id: 'req1' },
    });
  });

  it('an ADMIN deleting an APPROVED request deletes the linked Trip too', async () => {
    const { service, prisma } = makeReadService({ request: approvedRequest() });

    await expect(service.remove(adminUser, 'req1')).resolves.toEqual({
      success: true,
    });
    expect(prisma.trip.deleteMany).toHaveBeenCalledWith({
      where: { id: 'trip-99' },
    });
    expect(prisma.tripRequest.delete).toHaveBeenCalled();
  });

  it('no longer throws REQUEST_HAS_TRIP for an authorised delete', async () => {
    const { service } = makeReadService({ request: approvedRequest() });
    await expect(service.remove(clientUser, 'req1')).resolves.toEqual({
      success: true,
    });
  });

  it('runs BOTH deletes inside ONE transaction (no orphan window)', async () => {
    const { service, prisma } = makeReadService({ request: approvedRequest() });
    await service.remove(adminUser, 'req1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Both writes were issued by the client the transaction handed the callback, so
    // neither can commit without the other.
    const tx = prisma.$transaction.mock.calls[0][0];
    expect(typeof tx).toBe('function');
    expect(prisma.trip.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.tripRequest.delete).toHaveBeenCalledTimes(1);
  });

  it('a failing transaction surfaces the error — nothing is reported as deleted', async () => {
    const { service } = makeReadService({
      request: approvedRequest(),
      txFails: true,
    });
    await expect(service.remove(adminUser, 'req1')).rejects.toThrow(
      'transaction rolled back',
    );
  });

  it('still deletes when tripId points at an already-deleted Trip', async () => {
    // deleteMany (count 0), not delete — a P2025 here would roll the request delete back
    // and make the row permanently undeletable.
    const { service, prisma } = makeReadService({
      request: approvedRequest(),
      tripCount: 0,
    });
    await expect(service.remove(adminUser, 'req1')).resolves.toEqual({
      success: true,
    });
    expect(prisma.tripRequest.delete).toHaveBeenCalled();
  });
});

/* ================================================================ */
/* Route permissions — the CLIENT must not bypass the request flow   */
/* ================================================================ */

/**
 * A CLIENT reaches a trip only through POST /trip-requests → ADMIN approve, which is
 * where the driver is assigned. Creating a trip directly would skip both the approval
 * and the mandatory driver details, so POST /trips is ADMIN-only. These assert the
 * decorators themselves through the real RolesGuard, so a decorator edit fails here.
 */
function tripsGuardCtx(handler: any, user: any) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => TripsController,
  } as any;
}

describe('trip creation route permissions', () => {
  const guard = new RolesGuard(new Reflector());

  it('ADMIN may POST /trips', () => {
    expect(
      guard.canActivate(
        tripsGuardCtx(TripsController.prototype.create, { role: 'ADMIN' }),
      ),
    ).toBe(true);
  });

  it('CLIENT may NOT POST /trips (must use the request workflow)', () => {
    expect(
      guard.canActivate(
        tripsGuardCtx(TripsController.prototype.create, { role: 'CLIENT' }),
      ),
    ).toBe(false);
  });

  it('CLIENT may POST /trip-requests', () => {
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.create, { role: 'CLIENT' }),
      ),
    ).toBe(true);
  });

  it('ADMIN may NOT POST /trip-requests (only clients raise requests)', () => {
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.create, { role: 'ADMIN' }),
      ),
    ).toBe(false);
  });

  it('approve and reject stay ADMIN-only', () => {
    for (const handler of [
      TripRequestsController.prototype.approve,
      TripRequestsController.prototype.reject,
    ]) {
      expect(guard.canActivate(guardCtx(handler, { role: 'ADMIN' }))).toBe(true);
      expect(guard.canActivate(guardCtx(handler, { role: 'CLIENT' }))).toBe(false);
    }
  });

  it('delete is behind JwtAuthGuard, so an anonymous caller gets 401', () => {
    // Class-level @UseGuards(JwtAuthGuard, RolesGuard) — the JWT guard runs first, so a
    // request with no/invalid token never reaches the role check or the service.
    const guards = Reflect.getMetadata(
      '__guards__',
      TripRequestsController,
    ) as any[];
    expect(guards.map((g) => g.name)).toContain('JwtAuthGuard');
    expect(guards.map((g) => g.name)).toContain('RolesGuard');
  });

  it('delete stays open to both roles (the service scopes it)', () => {
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.remove, { role: 'ADMIN' }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.remove, { role: 'CLIENT' }),
      ),
    ).toBe(true);
  });
});

describe('TripRequest reference resolution (customer, reviewer, resulting trip)', () => {
  it('attaches the customer, reviewer and resulting trip with one batched lookup each', async () => {
    const prisma: any = {
      tripRequest: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'r1',
            clientId: 'client-1',
            vehicleId: null,
            customerId: 'cus-1',
            reviewedById: 'admin-1',
            tripId: 'trip-1',
          },
          {
            id: 'r2',
            clientId: 'client-1',
            vehicleId: null,
            customerId: 'cus-1',
            reviewedById: null,
            tripId: null,
          },
        ]),
      },
      vehicle: { findMany: jest.fn() },
      customer: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'cus-1', name: 'Lulu Hypermarket' }]),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'admin-1', name: 'Fleet Admin' }]),
      },
      trip: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'trip-1', reference: 'TRP-1001' }]),
      },
    };
    const service = new TripRequestsService(prisma, {} as any, {} as any);

    const { requests } = await service.findAll(adminUser);

    expect(requests[0].customer).toEqual({
      id: 'cus-1',
      name: 'Lulu Hypermarket',
    });
    expect(requests[0].reviewedBy).toEqual({
      id: 'admin-1',
      name: 'Fleet Admin',
    });
    expect(requests[0].trip).toEqual({ id: 'trip-1', reference: 'TRP-1001' });
    expect(requests[1].customer).toEqual({
      id: 'cus-1',
      name: 'Lulu Hypermarket',
    });
    expect(requests[1].reviewedBy).toBeNull();
    expect(requests[1].trip).toBeNull();
    expect(prisma.customer.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.customer.findMany.mock.calls[0][0].where.id.in).toEqual([
      'cus-1',
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.trip.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
  });
});
