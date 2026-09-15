import { BadRequestException } from '@nestjs/common';
import { CustomersService } from './customers.service';

/**
 * Slice B — customer list option access. `findAll` resolves the effective owning client
 * server-side: a CLIENT is pinned to its JWT id (any ?clientId ignored — no cross-tenant
 * read); an ADMIN must pass a validated ?clientId. customer.findMany drives the result;
 * client.findUnique echoes the queried id (or a forced value) for the ADMIN validation.
 */
function makeService(opts: any = {}) {
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
    customer: { findMany: jest.fn().mockResolvedValue([{ id: 'c1' }]) },
  };
  return { service: new CustomersService(prisma), prisma };
}

const adminUser = { userId: 'admin-1', role: 'ADMIN' };
const clientUser = { userId: 'client-1', role: 'CLIENT' };

describe('CustomersService.findAll — Slice B option access', () => {
  it('ADMIN + clientId A → only client A customers', async () => {
    const { service, prisma } = makeService();
    await service.findAll(adminUser, 'client-A');
    expect(prisma.customer.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-A',
    );
  });

  it('ADMIN + clientId B → only client B customers', async () => {
    const { service, prisma } = makeService();
    await service.findAll(adminUser, 'client-B');
    expect(prisma.customer.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-B',
    );
  });

  it('CLIENT → own customers only (JWT-scoped)', async () => {
    const { service, prisma } = makeService();
    await service.findAll(clientUser, undefined);
    expect(prisma.customer.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-1',
    );
  });

  it('CLIENT cannot use ?clientId to read another client’s customers', async () => {
    const { service, prisma } = makeService();
    await service.findAll(clientUser, 'other-client');
    expect(prisma.customer.findMany.mock.calls[0][0].where.clientId).toBe(
      'client-1',
    );
    // A CLIENT never triggers the ADMIN target-client lookup.
    expect(prisma.client.findUnique).not.toHaveBeenCalled();
  });

  it('ADMIN missing clientId → clean 400, no customer scan', async () => {
    const { service, prisma } = makeService();
    await expect(service.findAll(adminUser, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('ADMIN unknown clientId → clean 400 (INVALID_CLIENT), no customer scan', async () => {
    const { service, prisma } = makeService({ client: null });
    await expect(service.findAll(adminUser, 'ghost')).rejects.toMatchObject({
      message: 'INVALID_CLIENT',
    });
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });
});
