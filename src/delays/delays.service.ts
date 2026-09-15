import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateDelayDto } from './dto/create-delay.dto';
import { DelayStatsQueryDto } from './dto/delay-stats-query.dto';
import { driverKey } from '../common/utils/driver-key';
import {
  reportRangeEnd,
  reportRangeStart,
} from '../common/utils/report-date-range';

type AuthUser = { userId: string; role: string; accountType?: string };

type Granularity = 'day' | 'week' | 'month';

/** One aggregation bucket (per category / driver / route / period). */
export interface StatBucket {
  key: string;
  label: string;
  count: number;
  totalMinutes: number;
}

/** Enum value (e.g. TRAFFIC) → display label (Traffic). */
function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

/**
 * Reported-delay ingest/serve (DLY-01.1). A delay always belongs to a trip, so
 * authorization mirrors the trips module: ADMIN accesses all delays; a CLIENT is
 * scoped to delays on its own trips (derived from `trip.clientId` via the JWT).
 */
@Injectable()
export class DelaysService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  private readonly delayInclude = {
    trip: { select: { id: true, reference: true, clientId: true } },
  };

  /** A trip the caller may access (CLIENT owns it, ADMIN any); throws otherwise. */
  private async getAccessibleTrip(user: AuthUser, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (user.role === 'CLIENT' && trip.clientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
    return trip;
  }

  /** Ingest a reported delay against a trip (DLY-01.1). */
  async create(user: AuthUser, dto: CreateDelayDto) {
    const trip = await this.getAccessibleTrip(user, dto.tripId);

    const delay = await this.prisma.delay.create({
      data: {
        tripId: dto.tripId,
        category: dto.category,
        reason: dto.reason ?? null,
        remarks: dto.remarks ?? null,
        durationMinutes: dto.durationMinutes ?? 0,
        reportedAt: dto.reportedAt ? new Date(dto.reportedAt) : new Date(),
        source: dto.source ?? 'PORTAL',
        reportedBy: dto.reportedBy ?? null,
      },
      include: this.delayInclude,
    });

    // NOT-02.1: one "Delay reported" notification per successful report, scoped to
    // the owning client + trip. Deliberately independent of the ETA monitor — it
    // does NOT touch etaDelayAlertedAt / etaBaseline (a human report and an
    // ETA-predicted delay are distinct events). Non-throwing: a notification failure
    // never rolls back or fails the already-persisted delay report.
    await this.notifications.onDelayReported(
      { id: trip.id, reference: trip.reference, clientId: trip.clientId },
      { category: delay.category, durationMinutes: delay.durationMinutes },
    );

    return { success: true, delay };
  }

  /** List delays; ADMIN sees all, a CLIENT only its own trips' delays. */
  async findAll(user: AuthUser) {
    const where: Prisma.DelayWhereInput =
      user.role === 'CLIENT' ? { trip: { clientId: user.userId } } : {};

    const delays = await this.prisma.delay.findMany({
      where,
      include: this.delayInclude,
      orderBy: { reportedAt: 'desc' },
    });

    return { success: true, delays };
  }

  /** Delays reported for a single trip (DLY-01.1 — retrievable per trip). */
  async findByTrip(user: AuthUser, tripId: string) {
    await this.getAccessibleTrip(user, tripId);

    const delays = await this.prisma.delay.findMany({
      where: { tripId },
      orderBy: { reportedAt: 'desc' },
    });

    return { success: true, delays };
  }

  /**
   * Aggregate reported delays by category, driver, route and reporting period
   * (DLY-04.1). Read-only; derived entirely from the existing Delay + Trip data
   * with the same role scoping as `findAll` (ADMIN all, CLIENT own trips) plus an
   * optional `reportedAt` range. A single scoped `findMany` is reduced in memory,
   * because Prisma `groupBy` cannot traverse the trip relation (driver/route) nor
   * date-truncate the period.
   */
  async getStats(user: AuthUser, query: DelayStatsQueryDto) {
    const period: Granularity = query.period ?? 'month';

    const reportedAt: Prisma.DateTimeFilter = {};
    if (query.from) reportedAt.gte = reportRangeStart(query.from);
    if (query.to) reportedAt.lte = reportRangeEnd(query.to);

    const where: Prisma.DelayWhereInput = {
      ...(user.role === 'CLIENT' ? { trip: { clientId: user.userId } } : {}),
      ...(query.from || query.to ? { reportedAt } : {}),
    };

    const delays = await this.prisma.delay.findMany({
      where,
      select: {
        category: true,
        durationMinutes: true,
        reportedAt: true,
        trip: {
          select: {
            driverId: true,
            driverName: true,
            origin: true,
            destination: true,
          },
        },
      },
    });

    const byCategory = new Map<string, StatBucket>();
    const byDriver = new Map<string, StatBucket>();
    const byRoute = new Map<string, StatBucket>();
    const byPeriod = new Map<string, StatBucket>();
    let count = 0;
    let totalMinutes = 0;

    for (const delay of delays) {
      const minutes = delay.durationMinutes ?? 0;
      count += 1;
      totalMinutes += minutes;

      this.bump(byCategory, delay.category, titleCase(delay.category), minutes);

      const driverBucket =
        driverKey(delay.trip.driverId, delay.trip.driverName) ?? 'UNASSIGNED';
      const driverLabel =
        delay.trip.driverName ?? delay.trip.driverId ?? 'Unassigned';
      this.bump(byDriver, driverBucket, driverLabel, minutes);

      const routeKey = `${delay.trip.origin} → ${delay.trip.destination}`;
      this.bump(byRoute, routeKey, routeKey, minutes);

      const periodKey = this.periodKey(delay.reportedAt, period);
      this.bump(byPeriod, periodKey, periodKey, minutes);
    }

    const byCount = (a: StatBucket, b: StatBucket) => b.count - a.count;
    const byKeyAsc = (a: StatBucket, b: StatBucket) =>
      a.key.localeCompare(b.key);

    return {
      success: true,
      range: { from: query.from ?? null, to: query.to ?? null, period },
      total: { count, totalMinutes },
      byCategory: [...byCategory.values()].sort(byCount),
      byDriver: [...byDriver.values()].sort(byCount),
      byRoute: [...byRoute.values()].sort(byCount),
      byPeriod: [...byPeriod.values()].sort(byKeyAsc),
    };
  }

  /**
   * Delay analysis report as a PDF (RPT-04.2 export). Reuses getStats for the
   * aggregation — no duplicated delay query — and the same pdfkit-to-Buffer approach
   * as the trip/cost reports (shared export infrastructure).
   */
  async generateStatsPdf(
    user: AuthUser,
    query: DelayStatsQueryDto,
  ): Promise<Buffer> {
    const stats = await this.getStats(user, query);

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    const section = (title: string, buckets: StatBucket[]) => {
      doc.moveDown();
      doc.fontSize(13).text(title);
      if (buckets.length === 0) {
        doc.fontSize(10).text('No data');
        return;
      }
      for (const bucket of buckets) {
        doc
          .fontSize(10)
          .text(
            `${bucket.label}: ${bucket.count} delays, ${bucket.totalMinutes} min`,
          );
      }
    };

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Delay Analysis Report', { align: 'center' });
      doc.moveDown();

      const period =
        stats.range.from || stats.range.to
          ? `${stats.range.from ?? '…'} to ${stats.range.to ?? '…'}`
          : 'All time';
      doc
        .fontSize(10)
        .text(`Period: ${period} (grouped by ${stats.range.period})`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(
        `Total: ${stats.total.count} delays, ${stats.total.totalMinutes} min`,
      );

      section('By category', stats.byCategory);
      section('By driver', stats.byDriver);
      section('By route', stats.byRoute);
      section('By period', stats.byPeriod);

      doc.end();
    });
  }

  /** Accumulate one delay into an aggregation bucket keyed by `key`. */
  private bump(
    map: Map<string, StatBucket>,
    key: string,
    label: string,
    minutes: number,
  ): void {
    const bucket = map.get(key) ?? { key, label, count: 0, totalMinutes: 0 };
    bucket.count += 1;
    bucket.totalMinutes += minutes;
    map.set(key, bucket);
  }

  /** Chronological bucket key for a report timestamp at the requested granularity. */
  private periodKey(date: Date, period: Granularity): string {
    const iso = date.toISOString();
    if (period === 'day') return iso.slice(0, 10); // YYYY-MM-DD
    if (period === 'month') return iso.slice(0, 7); // YYYY-MM

    // week → the Monday of that ISO week (UTC), an unambiguous sortable key.
    const monday = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const weekday = monday.getUTCDay(); // 0 = Sunday
    monday.setUTCDate(monday.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
    return monday.toISOString().slice(0, 10);
  }
}
