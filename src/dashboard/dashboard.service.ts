import { Injectable } from '@nestjs/common';
import { Prisma, TripStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveVehicleStatus } from '../common/utils/vehicle-status';
import {
  detectDelay,
  DEFAULT_DELAY_MARGIN_MINUTES,
} from '../trips/trip-delay.util';

/* ------------------------------------------------------------------ */
/* Weekly activity — day bucketing (DSH-05)                            */
/* ------------------------------------------------------------------ */

/**
 * Day boundaries for the weekly-activity chart are computed in THIS zone, never the
 * server's local timezone: production runs UTC while development may not, and which
 * day a trip lands in must not depend on where the process happens to run.
 *
 * Asia/Kolkata is a fixed +05:30 offset and has never observed DST, so a constant
 * offset is exact here and needs no timezone library. If FleetTrack ever goes
 * multi-region, replace this pair with a per-client zone + an Intl-based conversion;
 * nothing else in getWeeklyActivity has to change.
 */
const REPORT_TIME_ZONE = 'Asia/Kolkata';
const REPORT_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days the chart shows, including today. */
const WEEKLY_ACTIVITY_DAYS = 7;

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The calendar date (YYYY-MM-DD) an instant falls on in REPORT_TIME_ZONE. */
function zonedDateKey(instant: Date): string {
  return new Date(instant.getTime() + REPORT_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** Short weekday name for an instant, in REPORT_TIME_ZONE. */
function zonedWeekdayLabel(instant: Date): string {
  return WEEKDAY_LABELS[
    new Date(instant.getTime() + REPORT_OFFSET_MS).getUTCDay()
  ];
}

/** The UTC instant at which the zone-local day containing `instant` begins. */
function zonedDayStart(instant: Date): Date {
  return new Date(
    Date.parse(`${zonedDateKey(instant)}T00:00:00.000Z`) - REPORT_OFFSET_MS,
  );
}

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /**
   * Weekly activity (DSH-05): trips scheduled to start on each of the last 7 days,
   * today included, oldest → newest. Scoped by clientId exactly like the sibling
   * dashboard stats (the controller pins a CLIENT to its own id).
   *
   * One bounded query over the 7-day window, then bucketed in memory — the same
   * shape as getDeliveryMetrics. Prisma's groupBy cannot do this: grouping on a
   * DateTime groups by the exact instant, so seven trips at seven different times
   * would produce seven groups rather than seven days.
   *
   * Always returns exactly 7 buckets; days with no trips come back as 0 so the chart
   * draws an honest flat line instead of an empty or misleading gap.
   */
  async getWeeklyActivity(clientId?: string) {
    const todayStart = zonedDayStart(new Date());
    const windowStart = new Date(
      todayStart.getTime() - (WEEKLY_ACTIVITY_DAYS - 1) * DAY_MS,
    );
    const windowEnd = new Date(todayStart.getTime() + DAY_MS); // exclusive

    const where: Prisma.TripWhereInput = {
      ...(clientId ? { clientId } : {}),
      scheduledStart: { gte: windowStart, lt: windowEnd },
    };

    const trips = await this.prisma.trip.findMany({
      where,
      select: { scheduledStart: true },
    });

    // Zero-filled buckets first, so a day with no trips still appears.
    const counts = new Map<string, number>();
    const days = Array.from({ length: WEEKLY_ACTIVITY_DAYS }, (_, i) => {
      const dayStart = new Date(
        windowStart.getTime() + i * DAY_MS,
      );
      const date = zonedDateKey(dayStart);
      counts.set(date, 0);
      return { date, label: zonedWeekdayLabel(dayStart) };
    });

    for (const trip of trips) {
      const key = zonedDateKey(trip.scheduledStart);
      const current = counts.get(key);
      // Guard rather than assume: a boundary instant must never create an 8th bucket.
      if (current !== undefined) counts.set(key, current + 1);
    }

    return {
      success: true,
      data: {
        timeZone: REPORT_TIME_ZONE,
        days: days.map((d) => ({ ...d, value: counts.get(d.date) ?? 0 })),
      },
    };
  }

  /**
   * Delivery performance metrics (DSH-04.1). Historical on-time vs delayed split
   * over COMPLETED trips: the actual completedAt is compared to scheduledEnd via
   * the same ETA-05.1 delay rule (detectDelay + DEFAULT_DELAY_MARGIN_MINUTES), so a
   * "delayed delivery" means the same thing as everywhere else in the app. Scoped
   * by clientId like the other dashboard stats. Two queries — a count plus one
   * narrow findMany of completed trips' timestamps — so no N+1 and no per-trip work.
   *
   * The DELAYED lifecycle status is deliberately NOT used: a completed trip's status
   * is COMPLETED (DELAYED is a transient in-transit state), so only completedAt vs
   * scheduledEnd measures whether a delivery actually arrived late.
   */
  async getDeliveryMetrics(clientId?: string) {
    const where: Prisma.TripWhereInput = clientId ? { clientId } : {};

    const [total, completedTrips] = await Promise.all([
      this.prisma.trip.count({ where }),
      this.prisma.trip.findMany({
        where: { ...where, status: TripStatus.COMPLETED },
        select: { scheduledEnd: true, completedAt: true },
      }),
    ]);

    const completed = completedTrips.length;
    let delayed = 0;
    for (const trip of completedTrips) {
      // completedAt is stamped on the COMPLETED transition; fall back defensively.
      const arrival = trip.completedAt ?? trip.scheduledEnd;
      if (
        detectDelay(trip.scheduledEnd, arrival, DEFAULT_DELAY_MARGIN_MINUTES)
          .isDelayed
      ) {
        delayed += 1;
      }
    }
    const onTime = completed - delayed;

    const pct = (part: number, whole: number) =>
      whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

    return {
      success: true,
      data: {
        total,
        completed,
        onTime,
        delayed,
        completionRate: pct(completed, total),
        onTimeRate: pct(onTime, completed),
        delayedRate: pct(delayed, completed),
      },
    };
  }

  /**
   * Trip summary counts for the dashboard (DSH-01.1). One grouped query over the
   * existing Trip.status; the lifecycle statuses are folded into the four dashboard
   * buckets. Scoped by clientId the same way as the other dashboard stats (the
   * controller pins a CLIENT to its own id). No new schema, no per-trip work.
   *
   * Buckets mirror TRIP_SUMMARY_BUCKETS on the frontend so the card counts match
   * the drill-down filter (`delayed` = the DELAYED lifecycle status, which is what
   * the drill-down list filters on — not the on-the-fly ETA-05.1 prediction).
   */
  async getTripSummary(clientId?: string) {
    const where: Prisma.TripWhereInput = clientId ? { clientId } : {};

    const grouped = await this.prisma.trip.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    const countOf = (status: TripStatus) =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;

    return {
      success: true,
      data: {
        active:
          countOf(TripStatus.STARTED) +
          countOf(TripStatus.ONGOING) +
          countOf(TripStatus.DELAYED),
        upcoming: countOf(TripStatus.PLANNED) + countOf(TripStatus.ASSIGNED),
        delayed: countOf(TripStatus.DELAYED),
        completed: countOf(TripStatus.COMPLETED),
      },
    };
  }

  async getDashboardStats(clientId?: string) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: clientId
        ? {
            clientId,
          }
        : undefined,
      // Only the two columns this function reads: effectiveVehicleStatus takes
      // { status, isOnline }, and totalVehicles is the row count. The counters and the
      // response shape are unchanged — this just stops shipping ~20 unused columns
      // per vehicle back from Postgres.
      select: { status: true, isOnline: true },
    });

    let totalVehicles = vehicles.length;
    let activeVehicles = 0;
    let offlineVehicles = 0;
    let idleVehicles = 0;

    // Reads the status TrackingService already decided and persisted — the same value
    // /tracking renders — instead of recomputing it here from ignition + speed. The old
    // local calculation ignored GPS freshness, so a vehicle could be OFFLINE on /tracking
    // and counted active here at the same moment.
    vehicles.forEach((vehicle) => {
      const status = effectiveVehicleStatus(vehicle);

      if (status === 'MOVING') {
        activeVehicles++;
      }

      if (status === 'IDLE') {
        idleVehicles++;
      }

      if (status === 'OFFLINE') {
        offlineVehicles++;
      }
    });

    return {
      success: true,
      data: {
        totalVehicles,
        activeVehicles,
        offlineVehicles,
        idleVehicles,
      },
    };
  }

  async getActiveVehicles(clientId?: string) {
  const vehicles = await this.prisma.vehicle.findMany({
    // Was `ignition: true`, which selected on engine state and therefore included
    // devices that had not reported in weeks but were frozen with ignition=true —
    // KL85B1418 (31 days stale, speed 13.2) sat in this widget labelled MOVING.
    // Selecting on the persisted live state excludes stale vehicles at the query
    // level, so a stale row can never reach the response. Both live states are kept
    // so the widget shows the same MOVING/IDLE mix it always did.
    where: {
      ...(clientId ? { clientId } : {}),
      isOnline: true,
      status: { in: ['MOVING', 'IDLE'] },
    },

    orderBy: {
      updatedAt: "desc",
    },

    take: 5,
  });

  const activeVehicles = vehicles.map((vehicle) => ({
    id: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
    driverName: vehicle.driverName,
    speed: vehicle.speed,
    // The stored status, not a re-derivation — same value /tracking shows.
    status: effectiveVehicleStatus(vehicle),
  }));

  return {
    success: true,
    data: activeVehicles,
  };
}
}