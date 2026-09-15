import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertTripCostDto } from './dto/upsert-trip-cost.dto';
import { CostReportQueryDto } from './dto/cost-report-query.dto';
import { computeCostVariance, COST_COMPONENTS } from './trip-cost.util';
import {
  reportRangeEnd,
  reportRangeStart,
} from '../common/utils/report-date-range';

type AuthUser = { userId: string; role: string; accountType?: string };

/**
 * Trip cost breakdown (TCM-01 / TCM-02). Cost belongs to a trip, so authorization
 * mirrors the trips module: a CLIENT accesses only its own trips' costs; an ADMIN
 * any (the controller restricts writes to CLIENT, matching trip ownership).
 */
@Injectable()
export class TripCostService {
  constructor(private prisma: PrismaService) {}

  /** A trip the caller may access (CLIENT owns it, ADMIN any); throws otherwise. */
  private async getAccessibleTrip(user: AuthUser, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (user.role === 'CLIENT' && trip.clientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
    return trip;
  }

  /**
   * Read a trip's cost breakdown (null until any cost has been entered) plus the
   * derived variance (TCM-04) — computed here, never stored.
   */
  async getByTrip(user: AuthUser, tripId: string) {
    await this.getAccessibleTrip(user, tripId);

    const cost = await this.prisma.tripCost.findUnique({ where: { tripId } });
    return { success: true, cost, variance: computeCostVariance(cost) };
  }

  /**
   * Upsert the cost breakdown (TCM-01.2 / TCM-02.1). Only the fields provided are
   * written, so saving the estimated group never clears the actual group (and vice
   * versa). Creates the row on first save (unspecified components default to 0).
   */
  async upsert(user: AuthUser, tripId: string, dto: UpsertTripCostDto) {
    await this.getAccessibleTrip(user, tripId);

    // Only defined amounts are persisted (partial estimated/actual updates).
    const data = {
      ...(dto.estimatedFuel !== undefined && {
        estimatedFuel: dto.estimatedFuel,
      }),
      ...(dto.estimatedTolls !== undefined && {
        estimatedTolls: dto.estimatedTolls,
      }),
      ...(dto.estimatedAllowance !== undefined && {
        estimatedAllowance: dto.estimatedAllowance,
      }),
      ...(dto.estimatedParking !== undefined && {
        estimatedParking: dto.estimatedParking,
      }),
      ...(dto.estimatedMaintenance !== undefined && {
        estimatedMaintenance: dto.estimatedMaintenance,
      }),
      ...(dto.estimatedMisc !== undefined && {
        estimatedMisc: dto.estimatedMisc,
      }),
      ...(dto.actualFuel !== undefined && { actualFuel: dto.actualFuel }),
      ...(dto.actualTolls !== undefined && { actualTolls: dto.actualTolls }),
      ...(dto.actualAllowance !== undefined && {
        actualAllowance: dto.actualAllowance,
      }),
      ...(dto.actualParking !== undefined && {
        actualParking: dto.actualParking,
      }),
      ...(dto.actualMaintenance !== undefined && {
        actualMaintenance: dto.actualMaintenance,
      }),
      ...(dto.actualMisc !== undefined && { actualMisc: dto.actualMisc }),
    };

    const cost = await this.prisma.tripCost.upsert({
      where: { tripId },
      create: { tripId, ...data },
      update: data,
    });

    return { success: true, cost, variance: computeCostVariance(cost) };
  }

  /**
   * Planned-vs-actual cost report across trips (TCM-05.1). One scoped query (trips
   * with their cost included — no N+1); per-trip totals reuse computeCostVariance,
   * and the per-component roll-up sums the same fields. Reusable by RPT-05 later.
   */
  private async buildReport(user: AuthUser, query: CostReportQueryDto) {
    const scheduledStart: Prisma.DateTimeFilter = {};
    if (query.from) scheduledStart.gte = reportRangeStart(query.from);
    if (query.to) scheduledStart.lte = reportRangeEnd(query.to);

    const where: Prisma.TripWhereInput = {
      ...(user.role === 'CLIENT'
        ? { clientId: user.userId }
        : query.clientId
          ? { clientId: query.clientId }
          : {}),
      ...(query.from || query.to ? { scheduledStart } : {}),
    };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        id: true,
        reference: true,
        origin: true,
        destination: true,
        status: true,
        cost: true,
      },
      orderBy: { scheduledStart: 'desc' },
    });

    const rows = trips.map((trip) => {
      const variance = computeCostVariance(trip.cost);
      return {
        tripId: trip.id,
        reference: trip.reference,
        origin: trip.origin,
        destination: trip.destination,
        status: trip.status,
        estimatedTotal: variance.estimatedTotal,
        actualTotal: variance.actualTotal,
        variance: variance.total,
      };
    });

    const byComponent = COST_COMPONENTS.map((component) => {
      let estimated = 0;
      let actual = 0;
      for (const trip of trips) {
        estimated += trip.cost?.[component.estimated] ?? 0;
        actual += trip.cost?.[component.actual] ?? 0;
      }
      return {
        component: component.key,
        estimated,
        actual,
        variance: actual - estimated,
      };
    });

    const totals = rows.reduce(
      (acc, row) => ({
        estimatedTotal: acc.estimatedTotal + row.estimatedTotal,
        actualTotal: acc.actualTotal + row.actualTotal,
        variance: acc.variance + row.variance,
      }),
      { estimatedTotal: 0, actualTotal: 0, variance: 0 },
    );

    return { rows, byComponent, totals };
  }

  /** Cost report data (TCM-05.1) as JSON for the report view. */
  async getReport(user: AuthUser, query: CostReportQueryDto) {
    const report = await this.buildReport(user, query);
    return { success: true, ...report };
  }

  /**
   * Cost report as a PDF (TCM-05.2 export). Reuses buildReport for the data and the
   * same pdfkit-to-Buffer approach as the vehicle report — no duplicate export code.
   */
  async generateReportPdf(
    user: AuthUser,
    query: CostReportQueryDto,
  ): Promise<Buffer> {
    const { rows, byComponent, totals } = await this.buildReport(user, query);

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Trip Cost Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`);
      doc.moveDown();

      doc.fontSize(13).text('Summary');
      doc
        .fontSize(11)
        .text(
          `Estimated: ${totals.estimatedTotal.toFixed(2)}   Actual: ${totals.actualTotal.toFixed(2)}   Variance: ${totals.variance.toFixed(2)}`,
        );
      doc.moveDown();

      doc.fontSize(13).text('By component');
      for (const component of byComponent) {
        doc
          .fontSize(10)
          .text(
            `${component.component}: estimated ${component.estimated.toFixed(2)}, actual ${component.actual.toFixed(2)}, variance ${component.variance.toFixed(2)}`,
          );
      }
      doc.moveDown();

      doc.fontSize(13).text('Trips');
      for (const row of rows) {
        doc
          .fontSize(10)
          .text(
            `${row.reference}  ${row.origin} -> ${row.destination}  [${row.status}]  est ${row.estimatedTotal.toFixed(2)} / act ${row.actualTotal.toFixed(2)} / var ${row.variance.toFixed(2)}`,
          );
      }

      doc.end();
    });
  }
}
