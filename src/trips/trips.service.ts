import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, TripEventAction, TripStatus } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripReportQueryDto } from './dto/trip-report-query.dto';
import { DriverReportQueryDto } from './dto/driver-report-query.dto';
import { VehicleReportQueryDto } from './dto/vehicle-report-query.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { UpdateTripStatusDto } from './dto/update-trip-status.dto';
import { OverlapQueryDto } from './dto/overlap-query.dto';
import {
  computeRouteProgress,
  haversineDistance,
  routeTotalDistance,
  GeoPoint,
} from './trip-progress.util';
import { computeStopOptimization } from './route-optimize.util';
import { computeEta, EtaResult } from './trip-eta.util';
import { detectDelay, DEFAULT_DELAY_MARGIN_MINUTES } from './trip-delay.util';
import {
  buildDelayAlert,
  buildEtaShiftAlert,
  DEFAULT_ETA_SHIFT_ALERT_MINUTES,
  EtaAlert,
} from './trip-eta-alert.util';
import { EtaAlertsQueryDto } from './dto/eta-alerts-query.dto';
import { GeocodingService } from '../geocoding/geocoding.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  reportRangeEnd,
  reportRangeStart,
} from '../common/utils/report-date-range';
import { driverIdFromName, driverKey } from '../common/utils/driver-key';

type AuthUser = { userId: string; role: string; accountType?: string };

/** In-memory per-driver tally used to build the driver performance report (RPT-02.1). */
interface DriverPerfAccumulator {
  driverId: string;
  driverName: string | null;
  totalTrips: number;
  completed: number;
  active: number;
  cancelled: number;
  onTime: number;
  delayed: number;
  totalDistanceKm: number;
  durationSum: number; // actual elapsed minutes over completed trips with both stamps
  durationCount: number;
}

/** In-memory per-vehicle tally used to build the vehicle utilization report (RPT-03.1). */
interface VehiclePerfAccumulator {
  vehicleId: string;
  vehicleNumber: string | null;
  vehicleName: string | null;
  totalTrips: number;
  completed: number;
  active: number;
  cancelled: number;
  onTime: number;
  delayed: number;
  totalDistanceKm: number;
  durationSum: number; // actual elapsed minutes over completed trips with both stamps
  durationCount: number;
  engagedMinutes: number; // busy time counted toward utilization
}

const ROUTE_DEVIATION_THRESHOLD_M = 2000;

/** Attempts to (re)generate a colliding reference before giving up (TM-01.2). */
const MAX_REFERENCE_ATTEMPTS = 5;

/**
 * Route distance (m) still remaining within which the vehicle counts as having
 * reached the final stop / destination — the completion tolerance for TM-02.2.
 */
const ARRIVAL_TOLERANCE_M = 250;

const STATUS_NOTE: Record<TripStatus, string> = {
  PLANNED: 'Trip created',
  ASSIGNED: 'Vehicle & driver assigned',
  STARTED: 'Trip started',
  ONGOING: 'In transit',
  DELAYED: 'Trip delayed',
  COMPLETED: 'Trip completed',
  CANCELLED: 'Trip cancelled',
};

/** Lifecycle state machine — allowed next statuses per current status. */
const TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  PLANNED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['STARTED', 'CANCELLED'],
  STARTED: ['ONGOING', 'DELAYED', 'CANCELLED'],
  ONGOING: ['DELAYED', 'COMPLETED', 'CANCELLED'],
  DELAYED: ['ONGOING', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Stops may only be added / removed / reordered before a trip starts (TM-05). */
const STOP_EDITABLE_STATUSES: TripStatus[] = [
  TripStatus.PLANNED,
  TripStatus.ASSIGNED,
];

/** Statuses for which a destination ETA is meaningful (trip in transit — ETA-01). */
const ETA_ACTIVE_STATUSES: TripStatus[] = [
  TripStatus.STARTED,
  TripStatus.ONGOING,
  TripStatus.DELAYED,
];

/** Statuses in which a stop may be marked completed — the trip is in transit (TM-02.2). */
const STOP_COMPLETABLE_STATUSES: TripStatus[] = [
  TripStatus.STARTED,
  TripStatus.ONGOING,
  TripStatus.DELAYED,
];

const tripInclude = {
  client: { select: { id: true, name: true } },
  vehicle: { select: { id: true, vehicleNumber: true, vehicleName: true } },
  customer: { select: { id: true, name: true } },
  stops: { orderBy: { sequence: 'asc' as const } },
};

/** The minimal trip shape the ETA monitor (ETA-06.1) loads and reasons over. */
interface EtaScanTrip {
  id: string;
  reference: string;
  clientId: string;
  status: TripStatus;
  scheduledEnd: Date;
  etaDelayAlertedAt: Date | null;
  etaBaseline: Date | null;
  originLat: number | null;
  originLng: number | null;
  destinationLat: number | null;
  destinationLng: number | null;
  stops: { lat: number | null; lng: number | null }[];
  vehicle: { latitude: number; longitude: number; speed: number | null } | null;
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private prisma: PrismaService,
    private geocoding: GeocodingService,
    private notifications: NotificationsService,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Reads                                                            */
  /* ---------------------------------------------------------------- */

  async findAll(
    user: AuthUser,
    selectedClientId?: string,
    statuses?: TripStatus[],
  ) {
    const where: Prisma.TripWhereInput = {};

    // ADMIN may narrow by a selected client; a CLIENT is pinned to its own trips.
    if (user.role === 'ADMIN' && selectedClientId) {
      where.clientId = selectedClientId;
    }
    if (user.role === 'CLIENT') {
      where.clientId = user.userId;
    }

    // Optional status filter, applied in the query so the database returns only the
    // matching rows. Omitted (or an empty list) leaves the list unfiltered, so every
    // existing caller is unaffected.
    if (statuses?.length) {
      where.status = { in: statuses };
    }

    const trips = await this.prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, trips: trips.map((t) => this.mapTrip(t)) };
  }

  async findOne(user: AuthUser, id: string) {
    const trip = await this.getReadable(user, id);
    return { success: true, trip: this.mapTrip(trip) };
  }

  async getTimeline(user: AuthUser, id: string) {
    await this.getReadable(user, id);

    const events = await this.prisma.tripEvent.findMany({
      where: { tripId: id },
      orderBy: { createdAt: 'asc' },
    });

    return { success: true, events: events.map((e) => this.mapEvent(e)) };
  }

  /**
   * GPS breadcrumb history (TM-21) — the trip's actual travelled path, recorded by
   * the tracking service while the trip was active. Ordered oldest→newest and
   * mapped to the frontend's TrailPoint shape for playback.
   */
  async getBreadcrumbs(user: AuthUser, id: string) {
    await this.getReadable(user, id);

    const crumbs = await this.prisma.tripBreadcrumb.findMany({
      where: { tripId: id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      success: true,
      breadcrumbs: crumbs.map((c) => ({
        lat: c.latitude,
        lng: c.longitude,
        timestamp: c.createdAt.getTime(),
        heading: c.heading,
        speed: c.speed,
      })),
    };
  }

  async getProgress(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true } },
        vehicle: {
          select: {
            id: true,
            vehicleNumber: true,
            vehicleName: true,
            latitude: true,
            longitude: true,
          },
        },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    return {
      success: true,
      progress: {
        ...progress,
        hasVehiclePosition,
        isDeviating:
          hasVehiclePosition &&
          progress.deviationMeters > ROUTE_DEVIATION_THRESHOLD_M,
      },
      vehiclePosition: position,
    };
  }

  /**
   * Destination ETA (ETA-01.1 / ETA-01.2). Fully derived: reuses the route-progress
   * `remainingMeters` and the assigned vehicle's live speed (falling back to an
   * average) — no Maps travel time, no external calls. ETA is null unless the trip
   * is in transit, has a live position, and has distance remaining.
   */
  async getEta(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        vehicle: { select: { latitude: true, longitude: true, speed: true } },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const { eta, remainingMeters, hasVehiclePosition } = this.computeTripEta(
      trip,
      new Date(),
    );

    return {
      success: true,
      eta: eta
        ? {
            etaTimestamp: eta.etaTimestamp,
            etaSeconds: eta.etaSeconds,
            basisSpeedKmh: eta.basisSpeedKmh,
            remainingMeters,
            hasVehiclePosition,
          }
        : null,
    };
  }

  /**
   * Shared destination-ETA core (ETA-01.1) reused by getEta and the ETA monitor —
   * one place for the "active + live position + distance remaining" gate so the
   * cron never duplicates the ETA maths. Pure given the loaded trip + `now`.
   */
  private computeTripEta(
    trip: {
      status: TripStatus;
      originLat: number | null;
      originLng: number | null;
      destinationLat: number | null;
      destinationLng: number | null;
      stops: { lat: number | null; lng: number | null }[];
      vehicle: {
        latitude: number;
        longitude: number;
        speed: number | null;
      } | null;
    },
    now: Date,
  ): {
    eta: EtaResult | null;
    remainingMeters: number;
    hasVehiclePosition: boolean;
  } {
    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    const canEstimate =
      ETA_ACTIVE_STATUSES.includes(trip.status) &&
      hasVehiclePosition &&
      progress.remainingMeters > 0;

    const eta = canEstimate
      ? computeEta(progress.remainingMeters, trip.vehicle?.speed, now)
      : null;

    return {
      eta,
      remainingMeters: progress.remainingMeters,
      hasVehiclePosition,
    };
  }

  /**
   * Per-stop arrival prediction (ETA-03.1). Reuses the destination-ETA machinery:
   * the route-progress `coveredMeters` and the same `computeEta` engine, applying
   * the identical ETA_ACTIVE_STATUSES + live-position guards as getEta. For each
   * remaining stop it derives distance-still-to-cover along the same route polyline
   * (cumulative-to-stop − covered) and predicts an ETA. Passed/completed stops
   * (covered ≥ cumulative) are skipped; order follows the stop sequence.
   */
  async getStopEtas(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        vehicle: { select: { latitude: true, longitude: true, speed: true } },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    const canEstimate =
      ETA_ACTIVE_STATUSES.includes(trip.status) && hasVehiclePosition;

    if (!canEstimate) {
      return { success: true, stops: [] };
    }

    const now = new Date();
    const covered = progress.coveredMeters;

    // Walk the same origin → stops polyline routePoints() builds (coordless nodes
    // skipped), accumulating cumulative distance so each stop's remaining distance
    // is measured consistently with `covered`.
    const prefix: GeoPoint[] =
      trip.originLat != null && trip.originLng != null
        ? [{ lat: trip.originLat, lng: trip.originLng }]
        : [];

    const stops: Array<{
      stopId: string;
      sequence: number;
      address: string;
      remainingMeters: number;
      etaTimestamp: string;
      etaSeconds: number;
      basisSpeedKmh: number;
    }> = [];

    for (const stop of trip.stops) {
      if (stop.lat == null || stop.lng == null) continue; // no coords → can't predict

      prefix.push({ lat: stop.lat, lng: stop.lng });
      const remainingToStop = routeTotalDistance(prefix) - covered;
      if (remainingToStop <= 0) continue; // passed / completed stop

      const eta = computeEta(remainingToStop, trip.vehicle?.speed, now);
      stops.push({
        stopId: stop.id,
        sequence: stop.sequence,
        address: stop.address,
        remainingMeters: remainingToStop,
        etaTimestamp: eta.etaTimestamp,
        etaSeconds: eta.etaSeconds,
        basisSpeedKmh: eta.basisSpeedKmh,
      });
    }

    return { success: true, stops };
  }

  /**
   * Delay detection (ETA-05.1) — read-only. A trip is flagged delayed when its
   * reference arrival runs past `scheduledEnd` by more than the margin:
   *  - active trip  → predicted ETA (reuses getEta; falls back to now when no live
   *                   position is available);
   *  - not active but not terminal → the current time;
   *  - COMPLETED / CANCELLED       → never flagged.
   * No status change, no events, no notifications.
   */
  async getDelay(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const marginMinutes = DEFAULT_DELAY_MARGIN_MINUTES;

    // Terminal trips are never flagged.
    if (
      trip.status === TripStatus.COMPLETED ||
      trip.status === TripStatus.CANCELLED
    ) {
      const scheduledEnd = trip.scheduledEnd.toISOString();
      return {
        success: true,
        delay: {
          isDelayed: false,
          delayMinutes: 0,
          marginMinutes,
          scheduledEnd,
          referenceArrival: scheduledEnd,
        },
      };
    }

    let referenceArrival: Date;
    if (ETA_ACTIVE_STATUSES.includes(trip.status)) {
      // Reuse the ETA endpoint's prediction (no duplicated ETA logic).
      const { eta } = await this.getEta(user, id);
      referenceArrival = eta ? new Date(eta.etaTimestamp) : new Date();
    } else {
      // Not active, not terminal (PLANNED / ASSIGNED) → compare current time.
      referenceArrival = new Date();
    }

    return {
      success: true,
      delay: detectDelay(trip.scheduledEnd, referenceArrival, marginMinutes),
    };
  }

  /**
   * ETA alerts (ETA-06.1) — read-only detection foundation. Composes the existing
   * ETA-05.1 delay signal and the ETA engine into raisable alerts: a DELAY alert
   * when the trip runs past schedule, and (when a `baselineEtaTimestamp` is given)
   * an ETA_SHIFT alert when the live ETA has drifted significantly from it. No
   * status change, no persistence, no notification dispatch — delivering these to
   * users is the Notification module's job (not yet built). Access is enforced by
   * the reused getDelay/getEta.
   */
  async getEtaAlerts(user: AuthUser, id: string, query: EtaAlertsQueryDto) {
    const alerts: EtaAlert[] = [];

    // DELAY — reuse ETA-05.1 delay detection verbatim (also enforces read access).
    const { delay } = await this.getDelay(user, id);
    const delayAlert = buildDelayAlert(delay);
    if (delayAlert) alerts.push(delayAlert);

    // ETA_SHIFT — only when the caller supplies a baseline to compare against.
    let baselineEtaTimestamp: string | null = null;
    if (query.baselineEtaTimestamp) {
      baselineEtaTimestamp = query.baselineEtaTimestamp;
      const { eta } = await this.getEta(user, id);
      if (eta) {
        const shiftAlert = buildEtaShiftAlert(
          new Date(query.baselineEtaTimestamp),
          new Date(eta.etaTimestamp),
        );
        if (shiftAlert) alerts.push(shiftAlert);
      }
    }

    return {
      success: true,
      isDelayed: delay.isDelayed,
      baselineEtaTimestamp,
      alerts,
    };
  }

  /* ---------------------------------------------------------------- */
  /* ETA monitor (ETA-06.1) — server-side alert dispatch              */
  /* ---------------------------------------------------------------- */

  /**
   * Every minute, evaluate active trips and dispatch ETA alerts. Lives here (not in
   * the tracking module) so it can reuse NotificationsService without a circular
   * module dependency. Wrapped so a scan failure never crashes the scheduler; the
   * next tick retries. Delegates to the testable {@link runEtaAlertScan}.
   */
  @Cron('0 * * * * *')
  async scanEtaAlerts(): Promise<void> {
    try {
      await this.runEtaAlertScan(new Date());
    } catch (err) {
      this.logger.warn(
        `ETA alert scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Testable core of the ETA monitor: evaluate every active trip against `now`.
   * Per-trip failures are isolated so one bad trip never blocks the rest.
   */
  async runEtaAlertScan(now: Date): Promise<void> {
    const trips = await this.prisma.trip.findMany({
      where: { status: { in: ETA_ACTIVE_STATUSES } },
      include: {
        vehicle: { select: { latitude: true, longitude: true, speed: true } },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    for (const trip of trips) {
      try {
        await this.evaluateTripEtaAlerts(trip, now);
      } catch (err) {
        this.logger.warn(
          `ETA alert eval failed for trip ${trip.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * ETA-06.1 for one trip. Two independent, persisted-state conditions, at most one
   * notification per trip per tick:
   *
   *  A. ETA-predicted DELAY — reference arrival (predicted ETA, else `now`) runs past
   *     scheduledEnd + margin. Derived from the ETA calc, NEVER from trip.status; no
   *     status transition. Once per episode via the `etaDelayAlertedAt` flag; cleared
   *     on recovery so a later episode re-alerts.
   *  B. Significant ETA SHIFT — live ETA drifts ≥ threshold from the accepted
   *     `etaBaseline`. A significant drift (either direction) atomically re-baselines;
   *     only a *later* shift notifies (an earlier ETA is not a delay).
   *
   * Every state change is an atomic compare-and-set (updateMany with the prior value
   * in the WHERE) so it is safe across restarts and multiple instances. On a
   * notification persistence failure the claim is rolled back — but only if the row
   * still holds this scan's claimed value — so a future scan can retry.
   */
  private async evaluateTripEtaAlerts(
    trip: EtaScanTrip,
    now: Date,
  ): Promise<void> {
    const { eta } = this.computeTripEta(trip, now);
    const currentEta = eta ? new Date(eta.etaTimestamp) : null;

    // ---- Condition A: ETA-predicted delay ----
    const referenceArrival = currentEta ?? now;
    const delay = detectDelay(
      trip.scheduledEnd,
      referenceArrival,
      DEFAULT_DELAY_MARGIN_MINUTES,
    );
    let delayNotifiedThisTick = false;

    if (delay.isDelayed) {
      if (trip.etaDelayAlertedAt === null) {
        // CAS claim: null → now. Only one scanner/instance wins.
        const claim = await this.prisma.trip.updateMany({
          where: { id: trip.id, etaDelayAlertedAt: null },
          data: { etaDelayAlertedAt: now },
        });
        if (claim.count === 1) {
          const created = await this.notifications.onEtaDelay(
            trip,
            delay.delayMinutes,
          );
          if (created) {
            delayNotifiedThisTick = true;
          } else {
            // Rollback — only if the row still holds *our* claim (not a newer write).
            await this.prisma.trip.updateMany({
              where: { id: trip.id, etaDelayAlertedAt: now },
              data: { etaDelayAlertedAt: null },
            });
          }
        }
      }
      // else: episode already alerted → no duplicate.
    } else if (trip.etaDelayAlertedAt !== null) {
      // Recovery → re-arm for a future episode.
      await this.prisma.trip.updateMany({
        where: { id: trip.id },
        data: { etaDelayAlertedAt: null },
      });
    }

    // ---- Condition B: significant ETA shift (needs a current ETA) ----
    if (currentEta === null) return;

    if (trip.etaBaseline === null) {
      // First live ETA → establish the baseline; no notification.
      await this.prisma.trip.updateMany({
        where: { id: trip.id, etaBaseline: null },
        data: { etaBaseline: currentEta },
      });
      return;
    }

    const shiftAlert = buildEtaShiftAlert(
      trip.etaBaseline,
      currentEta,
      DEFAULT_ETA_SHIFT_ALERT_MINUTES,
    );
    if (!shiftAlert) return; // within tolerance → baseline held, no alert.

    // Significant drift (either direction) → CAS re-baseline to the new ETA.
    const oldBaseline = trip.etaBaseline;
    const claim = await this.prisma.trip.updateMany({
      where: { id: trip.id, etaBaseline: oldBaseline },
      data: { etaBaseline: currentEta },
    });
    if (claim.count !== 1) return; // lost the race → another scan re-baselined.

    const isLater = currentEta.getTime() > oldBaseline.getTime();

    // Notify only for a LATER shift, and never a second notification in the same tick
    // when the delay alert already fired (precedence). The baseline has still moved,
    // so the suppressed shift won't re-fire as a duplicate next tick.
    if (!isLater || delayNotifiedThisTick) return;

    const created = await this.notifications.onEtaShift(
      trip,
      shiftAlert.minutes,
    );
    if (!created) {
      // Rollback baseline — only if it still equals the value we claimed.
      await this.prisma.trip.updateMany({
        where: { id: trip.id, etaBaseline: currentEta },
        data: { etaBaseline: oldBaseline },
      });
    }
  }

  /**
   * Trip summary report data (RPT-01.1) — counts by status + per-trip rows over a
   * date range, scoped like findAll (CLIENT own trips, ADMIN all or by clientId).
   * One narrow findMany; the status breakdown is derived in memory (no extra query).
   * Shared by the JSON view and the PDF export.
   */
  private async buildTripSummary(user: AuthUser, query: TripReportQueryDto) {
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
        scheduledStart: true,
        driverName: true,
        vehicle: { select: { vehicleNumber: true } },
      },
      orderBy: { scheduledStart: 'desc' },
    });

    const statuses: TripStatus[] = [
      TripStatus.PLANNED,
      TripStatus.ASSIGNED,
      TripStatus.STARTED,
      TripStatus.ONGOING,
      TripStatus.DELAYED,
      TripStatus.COMPLETED,
      TripStatus.CANCELLED,
    ];
    const byStatus = statuses.map((status) => ({
      status,
      count: trips.filter((trip) => trip.status === status).length,
    }));

    const rows = trips.map((trip) => ({
      tripId: trip.id,
      reference: trip.reference,
      origin: trip.origin,
      destination: trip.destination,
      status: trip.status,
      scheduledStart: trip.scheduledStart.toISOString(),
      vehicleNumber: trip.vehicle?.vehicleNumber ?? null,
      driverName: trip.driverName ?? null,
    }));

    return {
      range: { from: query.from ?? null, to: query.to ?? null },
      total: trips.length,
      byStatus,
      rows,
    };
  }

  /** Trip summary report as JSON for the report view (RPT-01.1). */
  async getSummaryReport(user: AuthUser, query: TripReportQueryDto) {
    const report = await this.buildTripSummary(user, query);
    return { success: true, ...report };
  }

  /**
   * Trip summary report as a PDF (RPT-01.2 export). Reuses buildTripSummary for the
   * data and the same pdfkit-to-Buffer approach as the vehicle/cost reports — no
   * duplicated report query, no duplicated PDF generation.
   */
  async generateSummaryPdf(
    user: AuthUser,
    query: TripReportQueryDto,
  ): Promise<Buffer> {
    const { range, total, byStatus, rows } = await this.buildTripSummary(
      user,
      query,
    );

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Trip Summary Report', { align: 'center' });
      doc.moveDown();

      const period =
        range.from || range.to
          ? `${range.from ?? '…'} to ${range.to ?? '…'}`
          : 'All time';
      doc.fontSize(10).text(`Period: ${period}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(`Total trips: ${total}`);
      doc.moveDown();

      doc.fontSize(13).text('By status');
      for (const entry of byStatus) {
        doc.fontSize(10).text(`${entry.status}: ${entry.count}`);
      }
      doc.moveDown();

      doc.fontSize(13).text('Trips');
      for (const row of rows) {
        doc
          .fontSize(9)
          .text(
            `${row.reference}  ${row.origin} -> ${row.destination}  [${row.status}]  ${row.vehicleNumber ?? '-'} / ${row.driverName ?? '-'}`,
          );
      }

      doc.end();
    });
  }

  /**
   * Driver performance report data (RPT-02.1) — per-driver trip statistics over a
   * date range, scoped like findAll (CLIENT own trips, ADMIN all or by clientId).
   * One narrow findMany; every metric is derived in memory (no extra query, no N+1).
   *
   * Reuses the app-wide delay rule (ETA-05.1 detectDelay + DEFAULT_DELAY_MARGIN_
   * MINUTES) for on-time vs late deliveries — the exact definition DSH-04 uses — and
   * the same "active" bucket (STARTED/ONGOING/DELAYED) as the dashboard trip summary.
   * Trips with no assigned driver are excluded from the per-driver breakdown.
   */
  private async buildDriverPerformance(
    user: AuthUser,
    query: DriverReportQueryDto,
  ) {
    const scheduledStart: Prisma.DateTimeFilter = {};
    if (query.from) scheduledStart.gte = reportRangeStart(query.from);
    if (query.to) scheduledStart.lte = reportRangeEnd(query.to);

    const where: Prisma.TripWhereInput = {
      // A driver is an id OR a typed-in name (common/utils/driver-key.ts). Filtering on
      // driverId alone excluded every trip whose driver was typed in, which today is all.
      OR: [{ driverId: { not: null } }, { driverName: { not: null } }],
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
        driverId: true,
        driverName: true,
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

    // Aggregate per driver, keyed by driverId or, for a typed-in driver, the id derived from
    // the name (the same rule listDrivers issues).
    const byDriver = new Map<string, DriverPerfAccumulator>();
    for (const trip of trips) {
      const key = driverKey(trip.driverId, trip.driverName);
      if (!key) continue;
      let acc = byDriver.get(key);
      if (!acc) {
        acc = {
          driverId: key,
          driverName: trip.driverName ?? null,
          totalTrips: 0,
          completed: 0,
          active: 0,
          cancelled: 0,
          onTime: 0,
          delayed: 0,
          totalDistanceKm: 0,
          durationSum: 0,
          durationCount: 0,
        };
        byDriver.set(key, acc);
      }
      if (!acc.driverName && trip.driverName) acc.driverName = trip.driverName;

      acc.totalTrips += 1;
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

    const rows = [...byDriver.values()]
      .map((a) => ({
        driverId: a.driverId,
        driverName: a.driverName,
        totalTrips: a.totalTrips,
        completed: a.completed,
        active: a.active,
        cancelled: a.cancelled,
        onTime: a.onTime,
        delayed: a.delayed,
        completionRate: pct(a.completed, a.totalTrips),
        onTimeRate: pct(a.onTime, a.completed),
        totalDistanceKm: round1(a.totalDistanceKm),
        avgDurationMins:
          a.durationCount === 0
            ? 0
            : Math.round(a.durationSum / a.durationCount),
      }))
      .sort((x, y) => y.totalTrips - x.totalTrips);

    const totals = rows.reduce(
      (t, r) => ({
        drivers: t.drivers + 1,
        trips: t.trips + r.totalTrips,
        completed: t.completed + r.completed,
        active: t.active + r.active,
        cancelled: t.cancelled + r.cancelled,
        onTime: t.onTime + r.onTime,
        delayed: t.delayed + r.delayed,
        totalDistanceKm: round1(t.totalDistanceKm + r.totalDistanceKm),
      }),
      {
        drivers: 0,
        trips: 0,
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

  /** Driver performance report as JSON for the report view (RPT-02.1). */
  async getDriverReport(user: AuthUser, query: DriverReportQueryDto) {
    const report = await this.buildDriverPerformance(user, query);
    return { success: true, ...report };
  }

  /**
   * Driver performance report as a PDF (RPT-02.3 export). Reuses buildDriverPerformance
   * for the data and the same pdfkit-to-Buffer approach as the trip/cost reports — no
   * duplicated report query, no duplicated PDF generation.
   */
  async generateDriverPdf(
    user: AuthUser,
    query: DriverReportQueryDto,
  ): Promise<Buffer> {
    const { range, totals, rows } = await this.buildDriverPerformance(
      user,
      query,
    );

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Driver Performance Report', { align: 'center' });
      doc.moveDown();

      const period =
        range.from || range.to
          ? `${range.from ?? '…'} to ${range.to ?? '…'}`
          : 'All time';
      doc.fontSize(10).text(`Period: ${period}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(
        `Drivers: ${totals.drivers}  Trips: ${totals.trips}  Completed: ${totals.completed}  On-time: ${totals.onTime}  Late: ${totals.delayed}`,
      );
      doc.moveDown();

      doc.fontSize(13).text('By driver');
      for (const row of rows) {
        doc
          .fontSize(9)
          .text(
            `${row.driverName ?? row.driverId}: ${row.totalTrips} trips, ${row.completed} completed (${row.completionRate}%), ${row.onTime} on-time (${row.onTimeRate}%), ${row.delayed} late, ${row.totalDistanceKm} km, avg ${row.avgDurationMins} min`,
          );
      }

      doc.end();
    });
  }

  /**
   * Vehicle utilization report data (RPT-03.1) — per-vehicle trip statistics over a
   * date range, scoped like findAll (CLIENT own trips, ADMIN all or by clientId). One
   * narrow findMany; every metric is derived in memory (no extra query, no N+1). Reuses
   * the driver-report aggregation pattern (RPT-02) and the same delay/active definitions
   * (ETA-05.1 detectDelay, DSH-04 on-time rule, DSH "active" bucket).
   *
   * Utilization is time-based: each vehicle's busy time (completed → actual elapsed
   * completedAt−startedAt, falling back to the scheduled window; active → scheduled
   * window; cancelled/upcoming → none) as a share of the reporting window. The window
   * is the requested from→to, or the observed scheduledStart→scheduledEnd span across
   * all in-scope trips when a bound is omitted — one shared denominator so vehicles are
   * comparable. Unlike driverName, vehicleNumber/vehicleName live on the Vehicle
   * relation (not the Trip), so they are included for the label. Trips with no assigned
   * vehicle are excluded.
   */
  private async buildVehicleUtilization(
    user: AuthUser,
    query: VehicleReportQueryDto,
  ) {
    const scheduledStart: Prisma.DateTimeFilter = {};
    if (query.from) scheduledStart.gte = reportRangeStart(query.from);
    if (query.to) scheduledStart.lte = reportRangeEnd(query.to);

    const where: Prisma.TripWhereInput = {
      vehicleId: { not: null },
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
        vehicleId: true,
        vehicle: { select: { vehicleNumber: true, vehicleName: true } },
        status: true,
        distanceKm: true,
        scheduledStart: true,
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

    // Shared utilization window: requested bounds, else the observed trip span.
    let observedStart = Number.POSITIVE_INFINITY;
    let observedEnd = Number.NEGATIVE_INFINITY;
    for (const trip of trips) {
      observedStart = Math.min(observedStart, trip.scheduledStart.getTime());
      observedEnd = Math.max(observedEnd, trip.scheduledEnd.getTime());
    }
    const windowStart = query.from
      ? reportRangeStart(query.from).getTime()
      : observedStart;
    const windowEnd = query.to
      ? reportRangeEnd(query.to).getTime()
      : observedEnd;
    const windowMinutes =
      Number.isFinite(windowStart) && Number.isFinite(windowEnd)
        ? Math.max(0, Math.round((windowEnd - windowStart) / 60000))
        : 0;

    // Aggregate per vehicle (keyed by vehicleId; the where filter guarantees non-null).
    const byVehicle = new Map<string, VehiclePerfAccumulator>();
    for (const trip of trips) {
      if (!trip.vehicleId) continue;
      let acc = byVehicle.get(trip.vehicleId);
      if (!acc) {
        acc = {
          vehicleId: trip.vehicleId,
          vehicleNumber: trip.vehicle?.vehicleNumber ?? null,
          vehicleName: trip.vehicle?.vehicleName ?? null,
          totalTrips: 0,
          completed: 0,
          active: 0,
          cancelled: 0,
          onTime: 0,
          delayed: 0,
          totalDistanceKm: 0,
          durationSum: 0,
          durationCount: 0,
          engagedMinutes: 0,
        };
        byVehicle.set(trip.vehicleId, acc);
      }

      acc.totalTrips += 1;
      acc.totalDistanceKm += trip.distanceKm;

      const scheduledMinutes = Math.max(
        0,
        Math.round(
          (trip.scheduledEnd.getTime() - trip.scheduledStart.getTime()) / 60000,
        ),
      );

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
            acc.engagedMinutes += mins;
          } else {
            acc.engagedMinutes += scheduledMinutes;
          }
        } else {
          acc.engagedMinutes += scheduledMinutes;
        }
      } else if (activeStatuses.includes(trip.status)) {
        acc.active += 1;
        acc.engagedMinutes += scheduledMinutes;
      } else if (trip.status === TripStatus.CANCELLED) {
        acc.cancelled += 1;
      }
    }

    const pct = (part: number, whole: number) =>
      whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
    const round1 = (n: number) => Math.round(n * 10) / 10;

    const rows = [...byVehicle.values()]
      .map((a) => ({
        vehicleId: a.vehicleId,
        vehicleNumber: a.vehicleNumber,
        vehicleName: a.vehicleName,
        totalTrips: a.totalTrips,
        completed: a.completed,
        active: a.active,
        cancelled: a.cancelled,
        onTime: a.onTime,
        delayed: a.delayed,
        completionRate: pct(a.completed, a.totalTrips),
        onTimeRate: pct(a.onTime, a.completed),
        utilizationPct:
          windowMinutes === 0
            ? 0
            : Math.min(100, round1((a.engagedMinutes / windowMinutes) * 100)),
        totalDistanceKm: round1(a.totalDistanceKm),
        avgDurationMins:
          a.durationCount === 0
            ? 0
            : Math.round(a.durationSum / a.durationCount),
      }))
      .sort((x, y) => y.utilizationPct - x.utilizationPct);

    const totals = rows.reduce(
      (t, r) => ({
        vehicles: t.vehicles + 1,
        trips: t.trips + r.totalTrips,
        completed: t.completed + r.completed,
        active: t.active + r.active,
        cancelled: t.cancelled + r.cancelled,
        onTime: t.onTime + r.onTime,
        delayed: t.delayed + r.delayed,
        totalDistanceKm: round1(t.totalDistanceKm + r.totalDistanceKm),
      }),
      {
        vehicles: 0,
        trips: 0,
        completed: 0,
        active: 0,
        cancelled: 0,
        onTime: 0,
        delayed: 0,
        totalDistanceKm: 0,
      },
    );

    const avgUtilizationPct =
      rows.length === 0
        ? 0
        : round1(rows.reduce((s, r) => s + r.utilizationPct, 0) / rows.length);

    return {
      range: { from: query.from ?? null, to: query.to ?? null },
      totals: { ...totals, avgUtilizationPct },
      rows,
    };
  }

  /** Vehicle utilization report as JSON for the report view (RPT-03.1). */
  async getVehicleReport(user: AuthUser, query: VehicleReportQueryDto) {
    const report = await this.buildVehicleUtilization(user, query);
    return { success: true, ...report };
  }

  /**
   * Vehicle utilization report as a PDF (RPT-03.3 export). Reuses buildVehicleUtilization
   * for the data and the same pdfkit-to-Buffer approach as the trip/driver/cost reports —
   * no duplicated report query, no duplicated PDF generation.
   */
  async generateVehiclePdf(
    user: AuthUser,
    query: VehicleReportQueryDto,
  ): Promise<Buffer> {
    const { range, totals, rows } = await this.buildVehicleUtilization(
      user,
      query,
    );

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Vehicle Utilization Report', { align: 'center' });
      doc.moveDown();

      const period =
        range.from || range.to
          ? `${range.from ?? '…'} to ${range.to ?? '…'}`
          : 'All time';
      doc.fontSize(10).text(`Period: ${period}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(
        `Vehicles: ${totals.vehicles}  Trips: ${totals.trips}  Completed: ${totals.completed}  Avg utilization: ${totals.avgUtilizationPct}%`,
      );
      doc.moveDown();

      doc.fontSize(13).text('By vehicle');
      for (const row of rows) {
        doc
          .fontSize(9)
          .text(
            `${row.vehicleNumber ?? row.vehicleId}: ${row.totalTrips} trips, ${row.completed} completed, ${row.onTime} on-time (${row.onTimeRate}%), ${row.delayed} late, ${row.utilizationPct}% util, ${row.totalDistanceKm} km, avg ${row.avgDurationMins} min`,
          );
      }

      doc.end();
    });
  }

  /**
   * Resource availability check (TM-09 / TM-10). Returns the active trips that
   * double-book a candidate vehicle OR driver for the given window. A CLIENT is
   * scoped to its own trips; an ADMIN checks across all trips.
   */
  async checkOverlap(user: AuthUser, query: OverlapQueryDto) {
    const resourceCount = [query.vehicleId, query.driverId].filter(
      Boolean,
    ).length;
    if (resourceCount !== 1) {
      throw new BadRequestException(
        'Provide exactly one of vehicleId or driverId',
      );
    }

    const start = new Date(query.start);
    const end = new Date(query.end);
    // An empty/invalid window can't clash with anything.
    if (!(end > start)) {
      return { success: true, hasOverlap: false, conflicts: [] };
    }

    // Scope: a CLIENT is pinned to its own trips (query clientId ignored — no cross-tenant
    // read). An ADMIN scopes to the selected client; with no client selected it does not
    // scan across clients (advisory pre-check — trip creation is the authoritative guard).
    let scopeClientId: string | undefined;
    if (user.role === 'CLIENT') {
      scopeClientId = user.userId;
    } else {
      if (!query.clientId) {
        return { success: true, hasOverlap: false, conflicts: [] };
      }
      scopeClientId = query.clientId;
    }

    const conflicts = await this.findOverlapConflicts({
      clientId: scopeClientId,
      vehicleId: query.vehicleId,
      driverId: query.driverId,
      start,
      end,
      excludeTripId: query.excludeTripId,
    });

    return { success: true, hasOverlap: conflicts.length > 0, conflicts };
  }

  /**
   * Assignable drivers for the trip create form (TM-10.1 driver lookup). The domain
   * models a driver only as `Vehicle.driverName` — there is no Driver entity or driver
   * id anywhere in the Phase-1 data — so the list is derived from the caller's vehicles:
   * distinct, non-empty driver names, scoped exactly like findAll (a CLIENT sees only
   * its own vehicles' drivers; an ADMIN sees all, or one client's via clientId).
   *
   * Identity is a deterministic, name-derived id (`drv:` + the lower-cased,
   * whitespace-collapsed name) — never random, never a vehicleId, never generated by the
   * client. It is exactly what the create call stores as Trip.driverId and what the
   * DRIVER_OVERLAP guard matches, so the same driver double-booked over an overlapping
   * window is still rejected. Same-named drivers collapse to a single entry: the Phase-1
   * model stores nothing else to tell them apart, and for a double-booking guard
   * collapsing (over-matching) is the fail-safe direction.
   */
  async listDrivers(user: AuthUser, clientId?: string) {
    // CLIENT sees its own drivers (query clientId ignored — no cross-tenant read). ADMIN
    // must target a selected client, resolved + validated exactly like trip creation, so it
    // never returns all clients' drivers and can't be pointed at a non-existent client.
    const where: Prisma.VehicleWhereInput = {
      clientId:
        user.role === 'CLIENT'
          ? user.userId
          : await this.resolveAdminTargetClient(clientId),
    };

    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: { driverName: true },
    });

    const byId = new Map<string, { id: string; name: string }>();
    for (const { driverName } of vehicles) {
      const name = driverName?.trim();
      const id = driverIdFromName(name);
      if (!name || !id) continue;
      if (!byId.has(id)) byId.set(id, { id, name });
    }

    const drivers = [...byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return { drivers };
  }

  /* ---------------------------------------------------------------- */
  /* Writes (CLIENT only — enforced by @Roles + ownership below)       */
  /* ---------------------------------------------------------------- */

  async create(user: AuthUser, dto: CreateTripDto) {
    // Resolve the owning client. A CLIENT always owns its own trips (userId IS the Client
    // id); any clientId in the body is ignored. An ADMIN creates on behalf of a selected
    // client, so the owner comes from dto.clientId — but only after validating that Client
    // exists (so an invalid id can't reach a DB FK failure), and every ownership/overlap
    // check below then runs against that real target.
    const ownerClientId =
      user.role === 'ADMIN'
        ? await this.resolveAdminTargetClient(dto.clientId)
        : user.userId;

    // An ADMIN creating a trip directly must name the driver and give a contact number.
    // Enforced here rather than on the DTO because the same CreateTripDto also carries a
    // CLIENT trip request, which deliberately has no driver at all (the ADMIN supplies it
    // at approval instead). Same shape as the clientId rule directly above.
    const driver =
      user.role === 'ADMIN' ? this.requireAdminDriver(dto) : null;

    // A linked customer must belong to the owning client (CUS-07.1) — the server-side
    // guarantee behind the form only listing that client's own customers.
    await this.assertOwnedCustomer(ownerClientId, dto.customerId);

    // A linked vehicle must also belong to the owning client — otherwise the trip could
    // attach another client's (or an unassigned) vehicle and leak its live
    // position/ETA/breadcrumbs through the trip read endpoints.
    await this.assertOwnedVehicle(ownerClientId, dto.vehicleId);

    // Reject double-booking of the vehicle/driver (409 VEHICLE_OVERLAP /
    // DRIVER_OVERLAP) — scoped to the owning client, matching the client pre-check.
    await this.assertNoResourceOverlap(ownerClientId, {
      vehicleId: dto.vehicleId,
      driverId: dto.driverId,
      start: new Date(dto.scheduledStart),
      end: new Date(dto.scheduledEnd),
    });

    const actor = await this.resolveActor(user);

    // Geocode addresses server-side (single source of truth) unless the caller
    // already supplied coordinates — this makes stored coords, and therefore
    // route/progress/deviation, real.
    const origin = await this.resolveCoords(
      dto.origin,
      dto.originLat,
      dto.originLng,
    );
    const destination = await this.resolveCoords(
      dto.destination,
      dto.destinationLat,
      dto.destinationLng,
    );
    const stops = await this.resolveStopCoords(dto.stops ?? []);

    // TM-01.2: a trip created with both a vehicle and a driver is already
    // assigned, so it persists as ASSIGNED; it only rests in PLANNED when
    // created without an assignment. A driver is now identified by name (typed by the
    // ADMIN) rather than only by driverId, so either satisfies "has a driver".
    const driverName = driver?.name ?? dto.driverName ?? null;
    const driverPhone = driver?.phone ?? dto.driverPhone ?? null;
    const initialStatus =
      dto.vehicleId && (dto.driverId || driverName)
        ? TripStatus.ASSIGNED
        : TripStatus.PLANNED;

    // TM-01.2: persist with a genuinely unique reference. `Trip.reference` has a
    // DB-level unique index; generation uses a CSPRNG (collision-resistant), and on the
    // astronomically rare collision we regenerate and retry. A caller-supplied reference
    // that is already taken is a hard 409 — never silently rewritten.
    const callerSuppliedReference =
      typeof dto.reference === 'string' && dto.reference.trim() !== '';

    for (let attempt = 0; attempt <= MAX_REFERENCE_ATTEMPTS; attempt++) {
      const reference = callerSuppliedReference
        ? dto.reference!.trim()
        : this.generateReference();
      try {
        const trip = await this.prisma.trip.create({
          data: {
            reference,
            status: initialStatus,
            clientId: ownerClientId, // CLIENT: self (JWT); ADMIN: the validated selected client
            vehicleId: dto.vehicleId ?? null,
            driverId: dto.driverId ?? null,
            driverName,
            driverPhone,
            customerId: dto.customerId ?? null,
            origin: dto.origin,
            originLat: origin.lat,
            originLng: origin.lng,
            destination: dto.destination,
            destinationLat: destination.lat,
            destinationLng: destination.lng,
            distanceKm: dto.distanceKm ?? 0,
            durationMins: dto.durationMins ?? 0,
            notes: dto.notes ?? null,
            scheduledStart: new Date(dto.scheduledStart),
            scheduledEnd: new Date(dto.scheduledEnd),
            stops: {
              create: stops,
            },
            events: {
              create: {
                action: TripEventAction.CREATED,
                status: initialStatus,
                note: STATUS_NOTE[initialStatus],
                actorRole: actor.role,
                actorName: actor.name,
              },
            },
          },
          include: tripInclude,
        });

        return { success: true, trip: this.mapTrip(trip) };
      } catch (err) {
        if (this.isReferenceConflict(err)) {
          // A specific reference the caller asked for is taken → 409 (do not change it).
          if (callerSuppliedReference) {
            throw new ConflictException('REFERENCE_TAKEN');
          }
          // Auto-generated collision → try a fresh reference on the next iteration.
          if (attempt < MAX_REFERENCE_ATTEMPTS) continue;
        }
        throw err;
      }
    }

    // Unreachable in practice (a CSPRNG reference colliding 5× is ~nil).
    throw new ConflictException('REFERENCE_GENERATION_FAILED');
  }

  async update(user: AuthUser, id: string, dto: UpdateTripDto) {
    const existing = await this.getOwned(user, id);

    // A (re)linked customer must belong to this client (CUS-07.1).
    await this.assertOwnedCustomer(user.userId, dto.customerId);

    // A (re)linked vehicle must also belong to this client (same ownership rule as create).
    await this.assertOwnedVehicle(user.userId, dto.vehicleId);

    // TM-05.1: stops may only be edited before the trip starts.
    if (
      dto.stops !== undefined &&
      !STOP_EDITABLE_STATUSES.includes(existing.status)
    ) {
      throw new BadRequestException('STOPS_LOCKED');
    }

    // Re-check availability against the effective resource + window after the
    // patch, excluding this trip from its own check.
    await this.assertNoResourceOverlap(user.userId, {
      vehicleId: dto.vehicleId ?? existing.vehicleId,
      driverId: dto.driverId ?? existing.driverId,
      start: dto.scheduledStart
        ? new Date(dto.scheduledStart)
        : existing.scheduledStart,
      end: dto.scheduledEnd ? new Date(dto.scheduledEnd) : existing.scheduledEnd,
      excludeTripId: id,
    });

    const actor = await this.resolveActor(user);

    // TM-16.1: make a (re)assignment auditable — a change to the vehicle or driver is
    // logged with a distinct note (actor + time are always captured on the event).
    const reassigned =
      (dto.vehicleId !== undefined && dto.vehicleId !== existing.vehicleId) ||
      (dto.driverId !== undefined && dto.driverId !== existing.driverId);

    const data: Prisma.TripUncheckedUpdateInput = {
      reference: dto.reference,
      vehicleId: dto.vehicleId,
      driverId: dto.driverId,
      driverName: dto.driverName,
      customerId: dto.customerId,
      distanceKm: dto.distanceKm,
      durationMins: dto.durationMins,
      notes: dto.notes,
      scheduledStart: dto.scheduledStart
        ? new Date(dto.scheduledStart)
        : undefined,
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
      events: {
        create: {
          action: TripEventAction.UPDATED,
          note: reassigned
            ? 'Vehicle/driver assignment updated'
            : 'Trip details updated',
          actorRole: actor.role,
          actorName: actor.name,
        },
      },
    };

    // Re-geocode origin/destination whenever they change (unless coords supplied).
    if (dto.origin !== undefined) {
      const origin = await this.resolveCoords(
        dto.origin,
        dto.originLat,
        dto.originLng,
      );
      data.origin = dto.origin;
      data.originLat = origin.lat;
      data.originLng = origin.lng;
    }
    if (dto.destination !== undefined) {
      const destination = await this.resolveCoords(
        dto.destination,
        dto.destinationLat,
        dto.destinationLng,
      );
      data.destination = dto.destination;
      data.destinationLat = destination.lat;
      data.destinationLng = destination.lng;
    }

    // TM-05.1: replace the whole stop list — delete existing stops and recreate
    // them in the new order with a fresh 1-based sequence + geocoded coords. One
    // atomic write covers add / remove / reorder.
    if (dto.stops !== undefined) {
      const stops = await this.resolveStopCoords(dto.stops);
      data.stops = {
        deleteMany: {},
        create: stops,
      };
    }

    const trip = await this.prisma.trip.update({
      where: { id },
      data,
      include: tripInclude,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  /**
   * TM-06.2 — compute an optimised stop order on the SERVER (greedy nearest-neighbour
   * over geocoded coordinates, with the pickup + destination fixed) and PERSIST the new
   * 1-based sequence. Allowed only before the trip starts (STOP_EDITABLE_STATUSES), like
   * manual stop editing; the client can still reorder manually afterwards via PATCH, so
   * manual override is preserved. Reuses the shared Haversine util — Google Routes
   * (TM-06.1) remains out of scope. CLIENT-scoped (ownership enforced by getOwned).
   */
  async optimizeStops(user: AuthUser, id: string) {
    const existing = await this.getOwned(user, id);

    // TM-05.1 rule: stops (and therefore their order) are frozen once the trip starts.
    if (!STOP_EDITABLE_STATUSES.includes(existing.status)) {
      throw new BadRequestException('STOPS_LOCKED');
    }

    const stops = await this.prisma.tripStop.findMany({
      where: { tripId: id },
      orderBy: { sequence: 'asc' },
    });
    // Fewer than two intermediate stops → nothing to reorder.
    if (stops.length < 2) {
      throw new BadRequestException('NOT_ENOUGH_STOPS');
    }

    // Resolve coordinates for the fixed endpoints and every stop (geocode any missing).
    const origin = await this.resolveCoords(
      existing.origin,
      existing.originLat,
      existing.originLng,
    );
    const destination = await this.resolveCoords(
      existing.destination,
      existing.destinationLat,
      existing.destinationLng,
    );
    if (
      origin.lat == null ||
      origin.lng == null ||
      destination.lat == null ||
      destination.lng == null
    ) {
      throw new BadRequestException('ROUTE_NOT_GEOCODABLE');
    }

    const stopCoords: GeoPoint[] = [];
    for (const stop of stops) {
      const c = await this.resolveCoords(stop.address, stop.lat, stop.lng);
      if (c.lat == null || c.lng == null) {
        throw new BadRequestException('ROUTE_NOT_GEOCODABLE');
      }
      stopCoords.push({ lat: c.lat, lng: c.lng });
    }

    const result = computeStopOptimization(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng },
      stopCoords,
    );

    const actor = await this.resolveActor(user);

    // Persist the optimised order: rewrite the stops in the new sequence (1-based),
    // keeping the coordinates we just resolved so a read doesn't re-geocode. Reuses the
    // delete+create idiom from update() for one atomic reorder.
    const reordered = result.order.map((originalIndex, i) => ({
      address: stops[originalIndex].address,
      sequence: i + 1,
      lat: stopCoords[originalIndex].lat,
      lng: stopCoords[originalIndex].lng,
    }));

    const trip = await this.prisma.trip.update({
      where: { id },
      data: {
        stops: { deleteMany: {}, create: reordered },
        events: {
          create: {
            action: TripEventAction.UPDATED,
            note: 'Stops optimised (nearest-neighbour)',
            actorRole: actor.role,
            actorName: actor.name,
          },
        },
      },
      include: tripInclude,
    });

    return {
      success: true,
      trip: this.mapTrip(trip),
      optimization: {
        order: result.order,
        originalDistanceMeters: result.originalDistanceMeters,
        optimizedDistanceMeters: result.optimizedDistanceMeters,
      },
    };
  }

  async updateStatus(user: AuthUser, id: string, dto: UpdateTripStatusDto) {
    const existing = await this.getOwned(user, id);

    if (!TRANSITIONS[existing.status].includes(dto.status)) {
      throw new BadRequestException(
        `Cannot change status from ${existing.status} to ${dto.status}`,
      );
    }

    // TM-02.2 — final-stop completion rule: a trip may only be COMPLETED once its final
    // ordered stop has been completed (deterministic; independent of live GPS).
    if (dto.status === TripStatus.COMPLETED) {
      await this.assertFinalStopCompleted(id);
    }

    const actor = await this.resolveActor(user);
    const now = new Date();
    const startsNow =
      dto.status === TripStatus.STARTED || dto.status === TripStatus.ONGOING;

    const trip = await this.prisma.trip.update({
      where: { id },
      data: {
        status: dto.status,
        startedAt: startsNow && !existing.startedAt ? now : undefined,
        completedAt: dto.status === TripStatus.COMPLETED ? now : undefined,
        events: {
          create: {
            action: TripEventAction.STATUS_CHANGED,
            status: dto.status,
            note: STATUS_NOTE[dto.status],
            actorRole: actor.role,
            actorName: actor.name,
          },
        },
      },
      include: tripInclude,
    });

    // NOT-01.2 / NOT-02.1 / NOT-03.1: raise an in-portal notification for the meaningful
    // transitions (started / delayed / completed). Reuses the same transition that already
    // writes the STATUS_CHANGED event; the notifications service decides which statuses
    // actually notify, so this call stays a single line and adds no logic to the trip flow.
    await this.notifications.onTripStatusChanged({
      id: trip.id,
      reference: trip.reference,
      clientId: trip.clientId,
      status: trip.status,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  /**
   * TM-02.2 — mark a stop reached/completed. CLIENT-owned trip only; the trip must be
   * in transit; stops complete strictly in sequence; an already-completed stop is an
   * idempotent no-op. GPS proximity (when available) annotates the audit event but never
   * gates completion. Writes the completion + a TripEvent atomically (TM-16.1 audit).
   */
  async completeStop(user: AuthUser, tripId: string, stopId: string) {
    const existing = await this.getOwned(user, tripId);

    if (!STOP_COMPLETABLE_STATUSES.includes(existing.status)) {
      throw new BadRequestException('STOP_NOT_COMPLETABLE');
    }

    const stops = await this.prisma.tripStop.findMany({
      where: { tripId },
      orderBy: { sequence: 'asc' },
    });

    const target = stops.find((s) => s.id === stopId);
    if (!target) throw new NotFoundException('Stop not found');

    // Idempotent: completing an already-completed stop changes nothing.
    if (target.completedAt) {
      const current = await this.prisma.trip.findUnique({
        where: { id: tripId },
        include: tripInclude,
      });
      return { success: true, trip: this.mapTrip(current) };
    }

    // Order rule: every earlier-sequence stop must already be completed.
    const earlierPending = stops.some(
      (s) => s.sequence < target.sequence && !s.completedAt,
    );
    if (earlierPending) throw new BadRequestException('STOP_OUT_OF_ORDER');

    const actor = await this.resolveActor(user);
    const gpsNote = await this.describeStopArrival(existing.vehicleId, target);

    const trip = await this.prisma.trip.update({
      where: { id: tripId },
      data: {
        stops: {
          update: {
            where: { id: stopId },
            data: { completedAt: new Date(), completedBy: actor.name },
          },
        },
        events: {
          create: {
            action: TripEventAction.UPDATED,
            note: `Stop ${target.sequence} reached: ${target.address}${gpsNote}`,
            actorRole: actor.role,
            actorName: actor.name,
          },
        },
      },
      include: tripInclude,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  async remove(user: AuthUser, id: string) {
    await this.getOwned(user, id);
    await this.prisma.trip.delete({ where: { id } });
    return { success: true };
  }

  /* ---------------------------------------------------------------- */
  /* Access helpers                                                    */
  /* ---------------------------------------------------------------- */

  /** A trip a CLIENT owns or an ADMIN may read; throws otherwise. */
  private async getReadable(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: tripInclude,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);
    return trip;
  }

  /** A trip the authenticated CLIENT owns; throws otherwise. */
  private async getOwned(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.clientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
    return trip;
  }

  private assertReadable(user: AuthUser, ownerClientId: string) {
    if (user.role === 'CLIENT' && ownerClientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
  }

  /**
   * A trip may only be linked to a customer the client owns (CUS-07.1). No-op when
   * no customer is being set; throws 400 INVALID_CUSTOMER otherwise.
   */
  private async assertOwnedCustomer(
    clientId: string,
    customerId?: string | null,
  ) {
    if (!customerId) return;
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, clientId },
    });
    if (!customer) throw new BadRequestException('INVALID_CUSTOMER');
  }

  /**
   * A trip may only be linked to a vehicle the client owns — otherwise a client could
   * attach another client's (or an unassigned) vehicle and read its live position, ETA
   * and breadcrumbs through the trip. No-op when no vehicle is being set or it's being
   * cleared (null); throws 400 INVALID_VEHICLE otherwise. Mirrors assertOwnedCustomer.
   */
  private async assertOwnedVehicle(
    clientId: string,
    vehicleId?: string | null,
  ) {
    if (!vehicleId) return;
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, clientId },
    });
    if (!vehicle) throw new BadRequestException('INVALID_VEHICLE');
  }

  /**
   * Public reuse hook for the Trip Request workflow: validate that the customer and
   * vehicle a CLIENT wants to put on a (future) trip belong to that client, using the
   * exact same private checks create()/update() run — so a trip request and a direct
   * trip enforce ownership identically. `user.userId` is the owning client id (CLIENT).
   */
  async assertOwnedTripResources(
    user: AuthUser,
    resources: { customerId?: string | null; vehicleId?: string | null },
  ) {
    await this.assertOwnedCustomer(user.userId, resources.customerId);
    await this.assertOwnedVehicle(user.userId, resources.vehicleId);
  }

  /**
   * Resolve + validate the target client for an ADMIN direct trip creation. The owner is
   * taken from the request body (dto.clientId) but trusted only after confirming the
   * Client exists — a missing/unknown id fails as a clean 400 (never a DB FK error), and
   * all downstream ownership/overlap checks then run against a real client. CLIENT callers
   * never reach this (they own their own trips via the JWT).
   */
  private async resolveAdminTargetClient(
    clientId?: string | null,
  ): Promise<string> {
    const id = typeof clientId === 'string' ? clientId.trim() : '';
    if (!id) throw new BadRequestException('CLIENT_REQUIRED');

    const client = await this.prisma.client.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!client) throw new BadRequestException('INVALID_CLIENT');

    return client.id;
  }

  /**
   * Driver name + phone for an ADMIN direct trip creation. Both are mandatory: an ADMIN
   * types them freely (there is no Driver entity), so this is the only place they can be
   * enforced. Whitespace-only counts as missing. A CLIENT never reaches this — its trip
   * request carries no driver, and the ADMIN supplies one at approval instead.
   */
  private requireAdminDriver(dto: CreateTripDto): {
    name: string;
    phone: string;
  } {
    const name = typeof dto.driverName === 'string' ? dto.driverName.trim() : '';
    if (!name) throw new BadRequestException('DRIVER_NAME_REQUIRED');

    const phone =
      typeof dto.driverPhone === 'string' ? dto.driverPhone.trim() : '';
    if (!phone) throw new BadRequestException('DRIVER_PHONE_REQUIRED');

    return { name, phone };
  }

  private async resolveActor(
    user: AuthUser,
  ): Promise<{ role: string; name: string | null }> {
    if (user.role === 'CLIENT') {
      const client = await this.prisma.client.findUnique({
        where: { id: user.userId },
        select: { name: true },
      });
      return { role: 'CLIENT', name: client?.name ?? null };
    }
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { name: true },
    });
    return { role: user.role, name: account?.name ?? null };
  }

  private generateReference(): string {
    const year = new Date().getFullYear();
    // 8 hex chars (~4.3e9 space) from a CSPRNG — collision-resistant; the DB unique
    // index + retry-on-collision in create() make the stored reference genuinely unique.
    const rand = randomBytes(4).toString('hex').toUpperCase();
    return `TRIP-${year}-${rand}`;
  }

  /** True when a Prisma error is a unique-constraint violation on Trip.reference. */
  private isReferenceConflict(err: unknown): boolean {
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== 'P2002'
    ) {
      return false;
    }
    const target = err.meta?.target;
    const mentionsReference = (value: string): boolean =>
      value.toLowerCase().includes('reference');
    if (Array.isArray(target)) {
      return target.some((t) => typeof t === 'string' && mentionsReference(t));
    }
    return typeof target === 'string' && mentionsReference(target);
  }

  /* ---------------------------------------------------------------- */
  /* Geocoding (server-side, via GeocodingService — single source)     */
  /* ---------------------------------------------------------------- */

  /** Use caller-supplied coordinates when present, else geocode the address. */
  private async resolveCoords(
    address: string,
    lat?: number | null,
    lng?: number | null,
  ): Promise<{ lat: number | null; lng: number | null }> {
    if (typeof lat === 'number' && typeof lng === 'number') {
      return { lat, lng };
    }
    const point = await this.geocoding.geocode(address);
    return { lat: point?.lat ?? null, lng: point?.lng ?? null };
  }

  /** Resolve coordinates for each stop (sequential; assigns a 1-based sequence). */
  private async resolveStopCoords(stops: NonNullable<CreateTripDto['stops']>) {
    const out: {
      address: string;
      sequence: number;
      lat: number | null;
      lng: number | null;
    }[] = [];
    for (let i = 0; i < stops.length; i++) {
      const coords = await this.resolveCoords(
        stops[i].address,
        stops[i].lat,
        stops[i].lng,
      );
      out.push({
        address: stops[i].address,
        sequence: i + 1,
        lat: coords.lat,
        lng: coords.lng,
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Overlap (double-booking) — one canonical query for check + guard  */
  /* ---------------------------------------------------------------- */

  /**
   * Active trips that book the same vehicle or driver during [start, end).
   * Half-open interval — touching edges (one ends exactly as the next begins) do
   * NOT clash — matching the client-side check. COMPLETED and CANCELLED trips have
   * released the resource, so they never block. When `clientId` is given the scan
   * is scoped to that client's trips.
   */
  private async findOverlapConflicts(params: {
    clientId?: string;
    vehicleId?: string | null;
    driverId?: string | null;
    start: Date;
    end: Date;
    excludeTripId?: string;
  }) {
    const where: Prisma.TripWhereInput = {
      status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
      scheduledStart: { lt: params.end },
      scheduledEnd: { gt: params.start },
    };

    if (params.clientId) where.clientId = params.clientId;
    if (params.vehicleId) where.vehicleId = params.vehicleId;
    if (params.driverId) where.driverId = params.driverId;
    if (params.excludeTripId) where.id = { not: params.excludeTripId };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        id: true,
        reference: true,
        scheduledStart: true,
        scheduledEnd: true,
        status: true,
      },
      orderBy: { scheduledStart: 'asc' },
    });

    return trips.map((t) => ({
      tripId: t.id,
      reference: t.reference,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
      status: t.status,
    }));
  }

  /**
   * Throws 409 VEHICLE_OVERLAP / DRIVER_OVERLAP if the vehicle or driver is already
   * booked for an overlapping window. Reuses findOverlapConflicts so the create /
   * update guard and the check endpoint share one algorithm.
   */
  private async assertNoResourceOverlap(
    clientId: string,
    params: {
      vehicleId?: string | null;
      driverId?: string | null;
      start: Date;
      end: Date;
      excludeTripId?: string;
    },
  ) {
    if (params.vehicleId) {
      const conflicts = await this.findOverlapConflicts({
        clientId,
        vehicleId: params.vehicleId,
        start: params.start,
        end: params.end,
        excludeTripId: params.excludeTripId,
      });
      if (conflicts.length > 0) {
        throw new ConflictException('VEHICLE_OVERLAP');
      }
    }

    if (params.driverId) {
      const conflicts = await this.findOverlapConflicts({
        clientId,
        driverId: params.driverId,
        start: params.start,
        end: params.end,
        excludeTripId: params.excludeTripId,
      });
      if (conflicts.length > 0) {
        throw new ConflictException('DRIVER_OVERLAP');
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Shaping helpers (Prisma row -> API shape the frontend consumes)   */
  /* ---------------------------------------------------------------- */

  /**
   * TM-02.2 — deterministic final-stop completion rule. A trip may only be COMPLETED
   * once its final ordered stop has been completed. Stops are completed strictly in
   * sequence (completeStop enforces order), so the last stop being done implies all
   * are. Trips with no intermediate stops have no final stop and complete freely
   * (single-stop / direct trips). Read entirely from persisted `completedAt` — it never
   * depends on live GPS availability (this supersedes the earlier fail-open guard).
   */
  private async assertFinalStopCompleted(id: string) {
    const stops = await this.prisma.tripStop.findMany({
      where: { tripId: id },
      orderBy: { sequence: 'asc' },
    });
    if (stops.length === 0) return;

    const finalStop = stops[stops.length - 1];
    if (!finalStop.completedAt) {
      throw new BadRequestException('FINAL_STOP_NOT_COMPLETED');
    }
  }

  /**
   * GPS-assist annotation for a stop completion — the repurposed route-progress signal.
   * Returns a short suffix noting whether the assigned vehicle's live position
   * corroborates arrival at the stop. Purely informational (never blocks; completion is
   * deterministic); empty when there is no telemetry to corroborate.
   */
  private async describeStopArrival(
    vehicleId: string | null,
    stop: { lat: number | null; lng: number | null },
  ): Promise<string> {
    if (!vehicleId || stop.lat == null || stop.lng == null) return '';

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { latitude: true, longitude: true },
    });
    const position = this.vehiclePosition(vehicle);
    if (!position) return '';

    const meters = haversineDistance(
      position.lat,
      position.lng,
      stop.lat,
      stop.lng,
    );
    return meters <= ARRIVAL_TOLERANCE_M
      ? ' (GPS-confirmed)'
      : ` (GPS ${Math.round(meters)} m away)`;
  }

  private routePoints(trip: {
    originLat: number | null;
    originLng: number | null;
    destinationLat: number | null;
    destinationLng: number | null;
    stops: { lat: number | null; lng: number | null }[];
  }): GeoPoint[] {
    const points: GeoPoint[] = [];
    if (trip.originLat != null && trip.originLng != null) {
      points.push({ lat: trip.originLat, lng: trip.originLng });
    }
    for (const s of trip.stops) {
      if (s.lat != null && s.lng != null) {
        points.push({ lat: s.lat, lng: s.lng });
      }
    }
    if (trip.destinationLat != null && trip.destinationLng != null) {
      points.push({ lat: trip.destinationLat, lng: trip.destinationLng });
    }
    return points;
  }

  private vehiclePosition(
    vehicle: { latitude: number; longitude: number } | null,
  ): GeoPoint | null {
    if (!vehicle) return null;
    const { latitude, longitude } = vehicle;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return null;
    }
    if (latitude === 0 && longitude === 0) return null;
    return { lat: latitude, lng: longitude };
  }

  private mapTrip(t: any) {
    return {
      id: t.id,
      reference: t.reference,
      status: t.status,
      clientId: t.clientId,
      client: t.client
        ? { id: t.client.id, name: t.client.name }
        : { id: t.clientId, name: '' },
      vehicleId: t.vehicleId,
      vehicle: t.vehicle
        ? {
            id: t.vehicle.id,
            vehicleNumber: t.vehicle.vehicleNumber,
            vehicleName: t.vehicle.vehicleName,
          }
        : null,
      driverId: t.driverId,
      driverName: t.driverName,
      // Captured at ADMIN create / approval; the trip CSV's "Driver Phone" column read it,
      // but it was never mapped, so that column was always empty.
      driverPhone: t.driverPhone ?? null,
      customerId: t.customerId,
      customer: t.customer
        ? { id: t.customer.id, name: t.customer.name }
        : null,
      origin: t.origin,
      originCoords:
        t.originLat != null && t.originLng != null
          ? { lat: t.originLat, lng: t.originLng }
          : undefined,
      destination: t.destination,
      destinationCoords:
        t.destinationLat != null && t.destinationLng != null
          ? { lat: t.destinationLat, lng: t.destinationLng }
          : undefined,
      stops: (t.stops ?? []).map(
        (s: {
          id: string;
          address: string;
          sequence: number;
          lat: number | null;
          lng: number | null;
          completedAt: Date | null;
          completedBy: string | null;
        }) => ({
          id: s.id,
          address: s.address,
          sequence: s.sequence,
          coords:
            s.lat != null && s.lng != null
              ? { lat: s.lat, lng: s.lng }
              : undefined,
          completedAt: s.completedAt ?? null,
          completedBy: s.completedBy ?? null,
        }),
      ),
      distanceKm: t.distanceKm,
      durationMins: t.durationMins,
      notes: t.notes,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private mapEvent(e: any) {
    return {
      id: e.id,
      tripId: e.tripId,
      action: e.action,
      status: e.status ?? null,
      note: e.note ?? null,
      actor: { role: e.actorRole, name: e.actorName ?? null },
      timestamp: e.createdAt,
    };
  }
}
