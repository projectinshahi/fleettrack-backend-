import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service';
import { Client, TripStatus } from '@prisma/client';
import { CreateClientDto } from './dto/create-client.dto';

/** Trip statuses that are actively running — a client with any of these can't be deleted. */
const ACTIVE_TRIP_STATUSES: TripStatus[] = [
  TripStatus.STARTED,
  TripStatus.ONGOING,
  TripStatus.DELAYED,
];

@Injectable()
export class ClientsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Map a Client to the fields that are safe to return to the frontend. An explicit
   * allowlist (not destructure-and-strip) so a future column can never leak by default:
   * the password hash and apiUrl (deprecated) are excluded.
   */
  private toSafeClient(client: Client) {
    return {
      id: client.id,
      name: client.name,
      email: client.email,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    };
  }

  /**
   * Create a client (a CLIENT login principal) and, atomically, assign the selected
   * vehicles to it. Runs in one transaction: if any selected vehicle is missing or
   * already assigned (or gets assigned by someone else mid-flight), nothing is created.
   * GPS provider credentials are never involved — apiUrl is deprecated (stored as '').
   */
  async create(dto: CreateClientDto) {
    const { name, email, password } = dto;
    const vehicleIds = dto.vehicleIds ?? [];

    const existingClient = await this.prisma.client.findUnique({
      where: { email },
    });
    if (existingClient) {
      throw new BadRequestException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const client = await this.prisma.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: { name, email, password: hashedPassword, apiUrl: '' },
      });

      if (vehicleIds.length > 0) {
        const vehicles = await tx.vehicle.findMany({
          where: { id: { in: vehicleIds } },
          select: { id: true, clientId: true, vehicleNumber: true },
        });

        if (vehicles.length !== vehicleIds.length) {
          throw new BadRequestException(
            'One or more selected vehicles do not exist',
          );
        }

        const alreadyAssigned = vehicles.filter((v) => v.clientId !== null);
        if (alreadyAssigned.length > 0) {
          throw new ConflictException(
            `Already assigned to another client: ${alreadyAssigned
              .map((v) => v.vehicleNumber)
              .join(', ')}`,
          );
        }

        // Assign only rows still unassigned; the count guards a concurrent assign
        // (any lost row → rollback, so the client is never partially created).
        const { count } = await tx.vehicle.updateMany({
          where: { id: { in: vehicleIds }, clientId: null },
          data: { clientId: created.id },
        });

        if (count !== vehicleIds.length) {
          throw new ConflictException(
            'One or more selected vehicles were just assigned by someone else — please retry',
          );
        }
      }

      return created;
    });

    return { success: true, client: this.toSafeClient(client) };
  }

  async findAll() {
    const clients = await this.prisma.client.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      clients: clients.map((client) => this.toSafeClient(client)),
    };
  }

  async update(id: string, body: any) {
    const { name, email } = body;

    const existingClient = await this.prisma.client.findUnique({
      where: { id },
    });
    if (!existingClient) {
      throw new NotFoundException('Client not found');
    }

    const updatedClient = await this.prisma.client.update({
      where: { id },
      data: { name, email },
    });

    return { success: true, client: this.toSafeClient(updatedClient) };
  }

  /**
   * Delete a client WITHOUT destroying inventory: the Vehicle.clientId FK is ON DELETE
   * SET NULL (migration 20260811160000_client_delete_setnull), so its vehicles return to
   * the unassigned pool with telemetry + history intact. Blocked while the client has an
   * active trip so an in-progress delivery is never broken.
   */
  async remove(id: string) {
    const existingClient = await this.prisma.client.findUnique({
      where: { id },
    });
    if (!existingClient) {
      throw new NotFoundException('Client not found');
    }

    const activeTrip = await this.prisma.trip.findFirst({
      where: { clientId: id, status: { in: ACTIVE_TRIP_STATUSES } },
      select: { id: true },
    });
    if (activeTrip) {
      throw new ConflictException(
        'Client has an active trip. Complete or cancel it before deleting.',
      );
    }

    await this.prisma.client.delete({ where: { id } });

    return { success: true, message: 'Client deleted' };
  }
}
