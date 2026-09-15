import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VehiclesService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: any, selectedClientId?: string, assignment?: string) {
  let where: any = {};

  // ADMIN selected specific client
  if (user.role === 'ADMIN' && selectedClientId) {
    where.clientId = selectedClientId;
  }

  // ADMIN requesting only unassigned inventory (for client-creation vehicle selection).
  if (user.role === 'ADMIN' && assignment === 'unassigned') {
    where.clientId = null;
  }

  // CLIENT login
  if (user.role === 'CLIENT') {
    where.clientId = user.userId;
  }

  const vehicles = await this.prisma.vehicle.findMany({
    where,
    include: {
      client: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return {
    success: true,
    vehicles,
  };
}

  async findOne(id: string, user: any) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
      // Only id + name — never the full Client row (which carries apiUrl + password hash).
      include: {
        client: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    this.assertVehicleReadable(vehicle.clientId, user);

    return {
      success: true,
      vehicle,
    };
  }

  async getVehicleHistory(id: string, user: any) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    this.assertVehicleReadable(vehicle.clientId, user);

    const raw = await this.prisma.vehicleLocationHistory.findMany({
      where: {
        vehicleId: id,
        createdAt: {
          gte: new Date(Date.now() - 60 * 60 * 1000),
        },
        NOT: {
          AND: [{ latitude: 0 }, { longitude: 0 }],
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 300,
    });

    const history = raw.reverse().map((item) => ({
      id: item.id,
      vehicleId: item.vehicleId,
      latitude: item.latitude,
      longitude: item.longitude,
      speed: item.speed,
      ignition: item.ignition,
      heading: item.heading,
      timestamp: item.createdAt.getTime(),
      createdAt: item.createdAt,
    }));

    return {
      success: true,
      vehicleId: id,
      total: history.length,
      history,
    };
  }

  async generateVehicleReport(id: string, user: any) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
      // The report only prints the client name — select it, don't include the full row.
      include: {
        client: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    this.assertVehicleReadable(vehicle.clientId, user);

    const doc = new PDFDocument({
      margin: 50,
    });

    const buffers: Uint8Array[] = [];

    doc.on('data', (chunk) => {
      buffers.push(chunk);
    });

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => {
        resolve(Buffer.concat(buffers));
      });

      doc.fontSize(24).text('Fleet Vehicle Report', {
        align: 'center',
      });

      doc.moveDown(2);

      doc.fontSize(16).text(`Vehicle Name: ${vehicle.vehicleName}`);
      doc.moveDown();

      doc.text(`Vehicle Number: ${vehicle.vehicleNumber}`);
      doc.moveDown();

      doc.text(`Driver Name: ${vehicle.driverName}`);
      doc.moveDown();

      doc.text(`Client Name: ${vehicle.client?.name ?? 'N/A'}`);
      doc.moveDown();

      doc.text(`GPS Device ID: ${vehicle.gpsDeviceId}`);
      doc.moveDown();

      doc.text(`Status: ${vehicle.status}`);
      doc.moveDown();

      doc.text(`Latitude: ${vehicle.latitude}`);
      doc.moveDown();

      doc.text(`Longitude: ${vehicle.longitude}`);
      doc.moveDown();

      doc.text(`Speed: ${vehicle.speed} km/h`);
      doc.moveDown();

      doc.text(`Generated At: ${new Date().toLocaleString()}`);

      doc.end();
    });
  }

  /**
   * A CLIENT may read only a vehicle assigned to it (its clientId === the client's own id,
   * which is `user.userId` in the JWT). ADMIN (and other staff) may read any vehicle.
   * Mirrors the trip module's `assertReadable` ownership check.
   */
  private assertVehicleReadable(
    vehicleClientId: string | null,
    user: any,
  ) {
    if (user?.role === 'CLIENT' && vehicleClientId !== user.userId) {
      throw new ForbiddenException('Not your vehicle');
    }
  }
}