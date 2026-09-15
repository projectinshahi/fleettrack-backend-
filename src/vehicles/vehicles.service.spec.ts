import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';

/**
 * Phase 10 security tests — vehicle client isolation + credential non-exposure.
 * PrismaService is mocked; these assert the ownership guard and the client `select`.
 */
describe('VehiclesService — client isolation (Phase 10)', () => {
  const vehicleA = {
    id: 'v1',
    clientId: 'clientA',
    vehicleName: 'Alpha',
    vehicleNumber: 'A1',
    driverName: 'Dev',
    gpsDeviceId: 'g1',
    status: 'IDLE',
    latitude: 1,
    longitude: 2,
    speed: 0,
    client: { id: 'clientA', name: 'A Co' },
  };

  const admin = { role: 'ADMIN', userId: 'admin1' };
  const clientA = { role: 'CLIENT', userId: 'clientA' };
  const clientB = { role: 'CLIENT', userId: 'clientB' };

  function makeService(vehicle: any) {
    const prisma: any = {
      vehicle: { findUnique: jest.fn().mockResolvedValue(vehicle) },
      vehicleLocationHistory: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { service: new VehiclesService(prisma), prisma };
  }

  it('CLIENT cannot read another client\'s vehicle (findOne)', async () => {
    const { service } = makeService(vehicleA);
    await expect(service.findOne('v1', clientB)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('CLIENT can read its own vehicle (findOne)', async () => {
    const { service } = makeService(vehicleA);
    const res = await service.findOne('v1', clientA);
    expect(res.vehicle.id).toBe('v1');
  });

  it('ADMIN can read any vehicle (findOne)', async () => {
    const { service } = makeService(vehicleA);
    const res = await service.findOne('v1', admin);
    expect(res.vehicle.id).toBe('v1');
  });

  it('findOne selects only client {id,name} — never the full client row', async () => {
    const { service, prisma } = makeService(vehicleA);
    await service.findOne('v1', admin);
    const arg = prisma.vehicle.findUnique.mock.calls[0][0];
    expect(arg.include.client.select).toEqual({ id: true, name: true });
    expect(arg.include.client).not.toBe(true); // guards against include:{client:true}
  });

  it('CLIENT cannot read another client\'s history', async () => {
    const { service } = makeService(vehicleA);
    await expect(
      service.getVehicleHistory('v1', clientB),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('CLIENT cannot generate another client\'s report', async () => {
    const { service } = makeService(vehicleA);
    await expect(
      service.generateVehicleReport('v1', clientB),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('missing vehicle → NotFound', async () => {
    const { service } = makeService(null);
    await expect(service.findOne('nope', admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
