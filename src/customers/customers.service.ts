import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AddressKind, Prisma, TripStatus } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { CustomerReportQueryDto } from './dto/customer-report-query.dto';
import {
  reportRangeEnd,
  reportRangeStart,
} from '../common/utils/report-date-range';
import {
  detectDelay,
  DEFAULT_DELAY_MARGIN_MINUTES,
} from '../trips/trip-delay.util';

/** In-memory per-customer tally used to build the delivery report (RPT-06.1). */
interface CustomerDeliveryAccumulator {
  customerId: string;
  customerName: string | null;
  customerType: string | null;
  totalDeliveries: number;
  completed: number;
  active: number;
  cancelled: number;
  onTime: number;
  delayed: number;
  totalDistanceKm: number;
  durationSum: number; // actual elapsed minutes over completed trips with both stamps
  durationCount: number;
}

/**
 * Customer directory CRUD (CUS-01 / CUS-02). Tenant-owned data: every operation is
 * scoped to the authenticated CLIENT (its `clientId`), so a client sees and mutates
 * only its own customers — mirroring the trips module's ownership model.
 */
@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async create(clientId: string, dto: CreateCustomerDto) {
    const customer = await this.prisma.customer.create({
      data: {
        clientId,
        name: dto.name,
        type: dto.type,
        company: dto.company ?? null,
        contactPerson: dto.contactPerson ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
        taxId: dto.taxId ?? null,
        registrationNumber: dto.registrationNumber ?? null,
        notes: dto.notes ?? null,
      },
    });

    return { success: true, customer };
  }

  async findAll(user: { userId: string; role: string }, queryClientId?: string) {
    const clientId = await this.resolveEffectiveClientId(user, queryClientId);
    const customers = await this.prisma.customer.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, customers };
  }

  /**
   * Effective owning client for a customer list. A CLIENT is always its own client (any
   * ?clientId is ignored — no cross-tenant read). An ADMIN must pass a target ?clientId,
   * validated to exist, so a missing id is a clean 400 (CLIENT_REQUIRED) and an unknown one
   * a clean 400 (INVALID_CLIENT) rather than silently returning all/empty customers.
   */
  private async resolveEffectiveClientId(
    user: { userId: string; role: string },
    queryClientId?: string,
  ): Promise<string> {
    if (user.role === 'CLIENT') return user.userId;

    const id = typeof queryClientId === 'string' ? queryClientId.trim() : '';
    if (!id) throw new BadRequestException('CLIENT_REQUIRED');

    const client = await this.prisma.client.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!client) throw new BadRequestException('INVALID_CLIENT');

    return client.id;
  }

  async findOne(clientId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, clientId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    return { success: true, customer };
  }

  async update(clientId: string, id: string, dto: UpdateCustomerDto) {
    await this.assertCustomer(clientId, id);

    const customer = await this.prisma.customer.update({
      where: { id },
      data: {
        name: dto.name,
        type: dto.type,
        company: dto.company,
        contactPerson: dto.contactPerson,
        email: dto.email,
        phone: dto.phone,
        address: dto.address,
        taxId: dto.taxId,
        registrationNumber: dto.registrationNumber,
        notes: dto.notes,
      },
    });

    return { success: true, customer };
  }

  async remove(clientId: string, id: string) {
    await this.assertCustomer(clientId, id);

    await this.prisma.customer.delete({ where: { id } });

    return { success: true, message: 'Customer deleted' };
  }

  /* ---------------------------------------------------------------- */
  /* Reusable pickup/delivery address book (CUS-05 / CUS-06)           */
  /* ---------------------------------------------------------------- */

  /** Assert the customer exists AND belongs to this client; throws otherwise. */
  private async assertCustomer(clientId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, clientId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
  }

  /** List a customer's addresses, optionally filtered by kind. */
  async listAddresses(clientId: string, customerId: string, kind?: string) {
    await this.assertCustomer(clientId, customerId);

    const validKind =
      kind === AddressKind.PICKUP || kind === AddressKind.DELIVERY
        ? (kind as AddressKind)
        : undefined;

    const addresses = await this.prisma.customerAddress.findMany({
      where: { customerId, ...(validKind ? { kind: validKind } : {}) },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return { success: true, addresses };
  }

  async addAddress(clientId: string, customerId: string, dto: CreateAddressDto) {
    await this.assertCustomer(clientId, customerId);

    const address = await this.prisma.customerAddress.create({
      data: {
        customerId,
        kind: dto.kind,
        label: dto.label,
        address: dto.address,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        isDefault: dto.isDefault ?? false,
      },
    });

    return { success: true, address };
  }

  async updateAddress(
    clientId: string,
    customerId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ) {
    await this.assertCustomer(clientId, customerId);

    const existing = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) throw new NotFoundException('Address not found');

    const address = await this.prisma.customerAddress.update({
      where: { id: addressId },
      data: {
        kind: dto.kind,
        label: dto.label,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        isDefault: dto.isDefault,
      },
    });

    return { success: true, address };
  }

  async removeAddress(clientId: string, customerId: string, addressId: string) {
    await this.assertCustomer(clientId, customerId);

    const existing = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) throw new NotFoundException('Address not found');

    await this.prisma.customerAddress.delete({ where: { id: addressId } });

    return { success: true, message: 'Address deleted' };
  }

  /* ---------------------------------------------------------------- */
  /* Trip history (CUS-07.2) — trips placed for this customer          */
  /* ---------------------------------------------------------------- */

  /**
   * List a customer's trips, newest first (CUS-07.2). Scoped to the authenticated
   * client — the customer must belong to it, and only that client's trips are
   * returned. Shaped for the shared trip table (reference / route / vehicle /
   * driver / schedule / status).
   */
  async listTrips(clientId: string, customerId: string) {
    await this.assertCustomer(clientId, customerId);

    const trips = await this.prisma.trip.findMany({
      where: { customerId, clientId },
      include: {
        vehicle: { select: { id: true, vehicleNumber: true, vehicleName: true } },
        stops: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      trips: trips.map((t) => ({
        id: t.id,
        reference: t.reference,
        status: t.status,
        origin: t.origin,
        destination: t.destination,
        vehicle: t.vehicle
          ? {
              id: t.vehicle.id,
              vehicleNumber: t.vehicle.vehicleNumber,
              vehicleName: t.vehicle.vehicleName,
            }
          : null,
        driverName: t.driverName,
        stops: t.stops.map((s) => ({ id: s.id })),
        scheduledStart: t.scheduledStart,
        scheduledEnd: t.scheduledEnd,
      })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Customer delivery report (RPT-06)                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Customer delivery report data (RPT-06.1) — per-customer delivery statistics over
   * a date range, scoped to the authenticated CLIENT (its own trips/customers, like
   * every customers-module read). One narrow findMany; every metric is derived in
   * memory (no extra query, no N+1). Reuses the driver/vehicle report aggregation
   * pattern (RPT-02/03) and the same delivery definitions: on-time vs late via the
   * app-wide ETA-05.1 detectDelay (as DSH-04), and the DSH "active"
   * (STARTED/ONGOING/DELAYED) bucket. Trips with no linked customer are excluded.
   */
  private async buildCustomerDeliveryReport(
    clientId: string,
    query: CustomerReportQueryDto,
  ) {
    const scheduledStart: Prisma.DateTimeFilter = {};
    if (query.from) scheduledStart.gte = reportRangeStart(query.from);
    if (query.to) scheduledStart.lte = reportRangeEnd(query.to);

    const where: Prisma.TripWhereInput = {
      clientId,
      customerId: { not: null },
      ...(query.from || query.to ? { scheduledStart } : {}),
    };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        customerId: true,
        customer: { select: { name: true, type: true } },
        status: true,
        distanceKm: true,
        scheduledEnd: true,
        startedAt: true,
        completedAt: true,
      },
      orderBy: { scheduledStart: 'desc' },
    });

    const activeStatuses: TripStatus[] = [
      TripStatus.STARTED,
      TripStatus.ONGOING,
      TripStatus.DELAYED,
    ];

    // Aggregate per customer (keyed by customerId; the where filter guarantees non-null).
    const byCustomer = new Map<string, CustomerDeliveryAccumulator>();
    for (const trip of trips) {
      if (!trip.customerId) continue;
      let acc = byCustomer.get(trip.customerId);
      if (!acc) {
        acc = {
          customerId: trip.customerId,
          customerName: trip.customer?.name ?? null,
          customerType: trip.customer?.type ?? null,
          totalDeliveries: 0,
          completed: 0,
          active: 0,
          cancelled: 0,
          onTime: 0,
          delayed: 0,
          totalDistanceKm: 0,
          durationSum: 0,
          durationCount: 0,
        };
        byCustomer.set(trip.customerId, acc);
      }

      acc.totalDeliveries += 1;
      acc.totalDistanceKm += trip.distanceKm;

      if (trip.status === TripStatus.COMPLETED) {
        acc.completed += 1;
        // completedAt is stamped on the COMPLETED transition; fall back defensively.
        const arrival = trip.completedAt ?? trip.scheduledEnd;
        if (
          detectDelay(trip.scheduledEnd, arrival, DEFAULT_DELAY_MARGIN_MINUTES)
            .isDelayed
        ) {
          acc.delayed += 1;
        } else {
          acc.onTime += 1;
        }
        if (trip.startedAt && trip.completedAt) {
          const mins = Math.round(
            (trip.completedAt.getTime() - trip.startedAt.getTime()) / 60000,
          );
          if (mins >= 0) {
            acc.durationSum += mins;
            acc.durationCount += 1;
          }
        }
      } else if (activeStatuses.includes(trip.status)) {
        acc.active += 1;
      } else if (trip.status === TripStatus.CANCELLED) {
        acc.cancelled += 1;
      }
    }

    const pct = (part: number, whole: number) =>
      whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
    const round1 = (n: number) => Math.round(n * 10) / 10;

    const rows = [...byCustomer.values()]
      .map((a) => ({
        customerId: a.customerId,
        customerName: a.customerName,
        customerType: a.customerType,
        totalDeliveries: a.totalDeliveries,
        completed: a.completed,
        active: a.active,
        cancelled: a.cancelled,
        onTime: a.onTime,
        delayed: a.delayed,
        completionRate: pct(a.completed, a.totalDeliveries),
        onTimeRate: pct(a.onTime, a.completed),
        totalDistanceKm: round1(a.totalDistanceKm),
        avgDurationMins:
          a.durationCount === 0
            ? 0
            : Math.round(a.durationSum / a.durationCount),
      }))
      .sort((x, y) => y.totalDeliveries - x.totalDeliveries);

    const totals = rows.reduce(
      (t, r) => ({
        customers: t.customers + 1,
        deliveries: t.deliveries + r.totalDeliveries,
        completed: t.completed + r.completed,
        active: t.active + r.active,
        cancelled: t.cancelled + r.cancelled,
        onTime: t.onTime + r.onTime,
        delayed: t.delayed + r.delayed,
        totalDistanceKm: round1(t.totalDistanceKm + r.totalDistanceKm),
      }),
      {
        customers: 0,
        deliveries: 0,
        completed: 0,
        active: 0,
        cancelled: 0,
        onTime: 0,
        delayed: 0,
        totalDistanceKm: 0,
      },
    );

    return {
      range: { from: query.from ?? null, to: query.to ?? null },
      totals,
      rows,
    };
  }

  /** Customer delivery report as JSON for the report view (RPT-06.1). */
  async getCustomerReport(clientId: string, query: CustomerReportQueryDto) {
    const report = await this.buildCustomerDeliveryReport(clientId, query);
    return { success: true, ...report };
  }

  /**
   * Customer delivery report as a PDF (RPT-06.2 export). Reuses buildCustomerDeliveryReport
   * for the data and the same pdfkit-to-Buffer approach as the trip/driver/vehicle/cost
   * reports — no duplicated report query, no duplicated PDF generation.
   */
  async generateCustomerPdf(
    clientId: string,
    query: CustomerReportQueryDto,
  ): Promise<Buffer> {
    const { range, totals, rows } = await this.buildCustomerDeliveryReport(
      clientId,
      query,
    );

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Customer Delivery Report', { align: 'center' });
      doc.moveDown();

      const period =
        range.from || range.to
          ? `${range.from ?? '…'} to ${range.to ?? '…'}`
          : 'All time';
      doc.fontSize(10).text(`Period: ${period}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(
        `Customers: ${totals.customers}  Deliveries: ${totals.deliveries}  Completed: ${totals.completed}  On-time: ${totals.onTime}  Late: ${totals.delayed}`,
      );
      doc.moveDown();

      doc.fontSize(13).text('By customer');
      for (const row of rows) {
        doc
          .fontSize(9)
          .text(
            `${row.customerName ?? row.customerId}${row.customerType ? ` (${row.customerType})` : ''}: ${row.totalDeliveries} deliveries, ${row.completed} completed (${row.completionRate}%), ${row.onTime} on-time (${row.onTimeRate}%), ${row.delayed} late, ${row.totalDistanceKm} km, avg ${row.avgDurationMins} min`,
          );
      }

      doc.end();
    });
  }
}
