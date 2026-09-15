import { NotificationsService } from './notifications.service';

/**
 * Slice 2 — notification audience + content (D2). A mocked Prisma captures what is
 * persisted; a mocked tracking gateway captures which Socket.IO room the `notification:new`
 * signal is emitted to. Client-scoped notifications go to `client:<id>`; admin-audience
 * ones (clientId null) go to `admins`. Reads are audience-scoped (CLIENT self, ADMIN null).
 */
function makeNotifications() {
  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  const prisma: any = {
    notification: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'n1', read: false, ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const gateway: any = { server: { to } };
  const service = new NotificationsService(prisma, gateway);
  return { service, prisma, to, emit };
}

const adminUser = { userId: 'admin-1', role: 'ADMIN' } as any;
const clientUser = { userId: 'client-1', role: 'CLIENT' } as any;

const req = {
  id: 'req1',
  clientId: 'client-1',
  origin: 'Kochi',
  destination: 'Calicut',
};

describe('TRIP_REQUESTED — admin audience', () => {
  it('persists with clientId null and emits to the admins room only', async () => {
    const { service, prisma, to } = makeNotifications();
    await service.onTripRequested(req);
    expect(prisma.notification.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        type: 'TRIP_REQUESTED',
        clientId: null,
        tripRequestId: 'req1',
      }),
    );
    expect(to).toHaveBeenCalledWith('admins');
    expect(to).not.toHaveBeenCalledWith('client:client-1');
  });
});

describe('read scoping (D2)', () => {
  it('scopes an ADMIN list to admin-audience only (clientId null, never {})', async () => {
    const { service, prisma } = makeNotifications();
    await service.list(adminUser, {} as any);
    expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ clientId: null }),
    );
  });

  it('scopes a CLIENT list to its own notifications (excludes admin-audience rows)', async () => {
    const { service, prisma } = makeNotifications();
    await service.list(clientUser, {} as any);
    expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ clientId: 'client-1' }),
    );
  });
});

describe('TRIP_REQUEST_APPROVED — requesting client only', () => {
  it('persists to the requesting client and emits to that client room only', async () => {
    const { service, prisma, to } = makeNotifications();
    await service.onTripRequestApproved(req, 'trip-9');
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({
        type: 'TRIP_REQUEST_APPROVED',
        clientId: 'client-1',
      }),
    );
    expect(to).toHaveBeenCalledWith('client:client-1');
    expect(to).not.toHaveBeenCalledWith('admins');
  });

  it('carries both tripRequestId and tripId', async () => {
    const { service, prisma } = makeNotifications();
    await service.onTripRequestApproved(req, 'trip-9');
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.tripRequestId).toBe('req1');
    expect(data.tripId).toBe('trip-9');
  });
});

describe('TRIP_REQUEST_REJECTED — requesting client only', () => {
  it('persists to the requesting client and emits to that client room only', async () => {
    const { service, prisma, to } = makeNotifications();
    await service.onTripRequestRejected({ ...req, rejectionReason: 'No capacity' });
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({
        type: 'TRIP_REQUEST_REJECTED',
        clientId: 'client-1',
      }),
    );
    expect(to).toHaveBeenCalledWith('client:client-1');
    expect(to).not.toHaveBeenCalledWith('admins');
  });

  it('carries tripRequestId and NO tripId', async () => {
    const { service, prisma } = makeNotifications();
    await service.onTripRequestRejected({ ...req, rejectionReason: 'No capacity' });
    const data = prisma.notification.create.mock.calls[0][0].data;
    expect(data.tripRequestId).toBe('req1');
    expect(data.tripId ?? null).toBeNull();
  });
});

describe('cross-client isolation', () => {
  it('emits an approval only to the owning client room, not another client', async () => {
    const { service, to } = makeNotifications();
    await service.onTripRequestApproved(req, 'trip-9');
    expect(to).toHaveBeenCalledWith('client:client-1');
    expect(to).not.toHaveBeenCalledWith('client:other-client');
  });

  it("a different client's read scope cannot match this client's notifications", async () => {
    const { service, prisma } = makeNotifications();
    await service.list({ userId: 'other-client', role: 'CLIENT' } as any, {} as any);
    expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ clientId: 'other-client' }),
    );
  });
});
