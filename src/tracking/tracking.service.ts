import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Vehicle, TripStatus, VehicleStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from './tracking.gateway';
import { GpsIntegrationService } from '../gps/gps-integration.service';
import {
  GpsProvider,
  NormalizedPosition,
  NormalizedVehicle,
} from '../gps/gps-provider.interface';
import {
  isPositionFresh,
  positionAgeMs,
  stalenessThresholdMs,
} from '../gps/gps-freshness';

function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));

  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function isValidCoord(lat: number, lng: number): boolean {
  if (isNaN(lat) || isNaN(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

const MIN_SAVE_DISTANCE_METERS = 10;

/** Trip statuses that are actively travelling and should record GPS breadcrumbs. */
const ACTIVE_TRIP_STATUSES: TripStatus[] = [
  TripStatus.STARTED,
  TripStatus.ONGOING,
  TripStatus.DELAYED,
];

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  // Reentrancy guard — a single poller. If a tick is still running (slow provider
  // or DB), the next @Cron tick is skipped rather than starting a second sync.
  private isSyncing = false;

  // Active trip ids grouped by vehicle, valid for ONE sync cycle only (cleared in the
  // `finally` of syncVehicles). Breadcrumb recording used to ask the Trip table for a
  // vehicle's active trips once per saved history point; this holds the answer for the
  // whole tick instead. Loaded lazily, so a tick in which nothing moved still costs zero
  // trip queries — exactly as before.
  private activeTripsByVehicle: Map<string, string[]> | null = null;

  // Each provider's vehicles keyed by providerVehicleId, valid for ONE sync cycle only
  // (cleared in the same `finally`). Identity resolution used to query the Vehicle table
  // once per position and again once per Transight inventory entry — for rows the same
  // cycle had just written. Loaded on the first lookup for a provider and kept in step with
  // every vehicle write the cycle makes, so each lookup sees what a fresh query would.
  private vehiclesByProvider: Map<string, Map<string, Vehicle>> | null = null;

  constructor(
    private prisma: PrismaService,
    private trackingGateway: TrackingGateway,
    private gpsIntegration: GpsIntegrationService,
  ) {}

  /**
   * Transient DB connectivity errors (e.g. Neon serverless cold-start or idle
   * disconnect). Safe to skip — the next scheduled tick retries.
   */
  private isTransientDbError(error: unknown): boolean {
    const e = error as { code?: string; errorCode?: string };
    const code = e?.code ?? e?.errorCode;
    return code === 'P1001' || code === 'P1002' || code === 'P1017';
  }

  /**
   * Vehicle status from its LATEST position.
   *
   * OFFLINE means "we have no recent GPS fix", nothing else. It previously meant
   * "ignition is off", which is a completely different fact and produced the two
   * contradictions this fleet was showing:
   *
   *   - a parked vehicle reporting perfectly was labelled OFFLINE, and the last speed
   *     it happened to be carrying was rendered next to that label as if current
   *     ("OFFLINE · 69 km/h");
   *   - a device dead for 28 days but frozen with ignition=true was labelled MOVING,
   *     because nothing ever checked how old the fix was.
   *
   * Engine-off with a fresh fix is IDLE (parked and reporting), which the existing
   * VehicleStatus enum already expresses — no schema change needed.
   */
  private deriveStatus(
    ignition: boolean,
    speed: number,
    fresh: boolean,
  ): VehicleStatus {
    if (!fresh) return 'OFFLINE';
    if (ignition && speed > 0) return 'MOVING';
    return 'IDLE';
  }

  /**
   * Poll every active GPS provider that is due (per-provider cadence, so Transight's
   * ~5-min bulk stays under its 500/day limit while AiroTrack can poll every minute),
   * normalize positions through the provider adapters, and upsert into the shared
   * vehicle inventory. A provider sync NEVER assigns a vehicle to a client: new
   * vehicles land as unassigned inventory (clientId = null); existing vehicles keep
   * their clientId untouched.
   */
  @Cron('0 * * * * *')
  async syncVehicles() {
    if (this.isSyncing) {
      this.logger.warn('Previous sync still running — skipping this tick');
      return;
    }
    this.isSyncing = true;

    try {
      const providers = await this.gpsIntegration.getActiveProviders();

      for (const { config, provider } of providers) {
        const dueMs = (config.pollIntervalSec ?? 300) * 1000;
        const last = config.lastSyncedAt ? config.lastSyncedAt.getTime() : 0;
        if (Date.now() - last < dueMs) continue; // not due yet (rate-limit cadence)

        try {
          const positions = await provider.getLatestPositions();

          // One summary line per provider per sync, not one per vehicle — this runs
          // every minute. Counts make the difference between "the provider is down"
          // and "the provider is up but its devices stopped reporting" obvious.
          let fresh = 0;
          let stale = 0;
          let noTimestamp = 0;
          let unresolved = 0;

          for (const pos of positions) {
            const outcome = await this.upsertPosition(
              pos,
              config.pollIntervalSec,
            );
            if (outcome === 'fresh') fresh++;
            else if (outcome === 'stale') stale++;
            else if (outcome === 'unresolved') unresolved++;
            else noTimestamp++;
          }

          this.logger.log(
            `Provider ${config.provider}: ${positions.length} positions ` +
              `(${fresh} fresh, ${stale} stale` +
              (noTimestamp ? `, ${noTimestamp} without a timestamp` : '') +
              // Non-zero means identity resolution is degraded — the condition that
              // used to create duplicates instead of reporting itself.
              (unresolved ? `, ${unresolved} SKIPPED (unresolved identity)` : '') +
              `, window ${Math.round(
                stalenessThresholdMs(config.pollIntervalSec) / 60000,
              )}m)`,
          );

          // Gap-fill from the inventory the adapter already cached while fetching those
          // positions. AFTER the position loop on purpose: every vehicle that HAS a fix is
          // already upserted with real telemetry, so this pass finds it and does nothing —
          // no placeholder is ever written and then overwritten. Its own try/catch so a
          // failure here cannot discard the positions we just synced or stamp an error on
          // a provider whose position sync succeeded.
          try {
            const created = await this.syncInventory(provider);
            if (created) {
              this.logger.log(
                `Provider ${config.provider}: created ${created} inventory-only ` +
                  `vehicle(s) that the provider lists but has never sent a position for`,
              );
            }
          } catch (inventoryError) {
            const msg =
              inventoryError instanceof Error
                ? inventoryError.message
                : String(inventoryError);
            this.logger.warn(
              `Inventory gap-fill for ${config.provider} failed (${msg}) — positions ` +
                `were synced normally; the next poll retries`,
            );
          }

          await this.gpsIntegration.markSynced(config.provider, null);
        } catch (providerError) {
          if (this.isTransientDbError(providerError)) {
            this.logger.warn(
              `DB temporarily unreachable while syncing ${config.provider} — skipping`,
            );
            continue;
          }
          const msg =
            providerError instanceof Error
              ? providerError.message
              : String(providerError);
          this.logger.error(`Provider ${config.provider} sync failed: ${msg}`);
          await this.gpsIntegration.markSynced(config.provider, msg);
        }
      }
    } catch (error) {
      if (this.isTransientDbError(error)) {
        this.logger.warn('DB temporarily unreachable — skipping this sync tick');
        return;
      }
      this.logger.error(
        'Vehicle sync failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isSyncing = false;
      // End of the sync cycle — drop the per-cycle snapshots so the next tick reloads
      // them and never acts on a stale trip or vehicle set.
      this.activeTripsByVehicle = null;
      this.vehiclesByProvider = null;
    }
  }

  /**
   * Resolve ONE provider identity to an existing Vehicle row, or null.
   *
   * Provider id first, then IMEI — and an IMEI hit RE-KEYS the row it found rather than
   * letting a second row be minted under the new key. Transight positions carry no
   * vehicle_id, so the adapter substitutes the IMEI whenever its inventory cache is cold;
   * once inventory loads the same truck arrives keyed by vehicle_id, and
   * @@unique([providerName, providerVehicleId]) treats that as a brand new vehicle. That
   * is exactly how 12 duplicate rows appeared on 2026-08-14.
   *
   * This is deliberately the ONLY path to the vehicle table for both the position loop and
   * the inventory gap-fill. A second, parallel lookup is how duplicates get back in —
   * neither unique constraint can stop them: @@unique([clientId, vehicleNumber]) is inert
   * because clientId is NULL for synced inventory (Postgres treats NULLs as distinct), and
   * @@unique([providerName, providerVehicleId]) is inert precisely when two rows are keyed
   * by different identities for the same device.
   *
   * The provider-id lookup reads the cycle's vehicle set (see vehiclesByProvider); that key
   * is unique, so the set gives the same answer the per-lookup query did. The IMEI fallback
   * is rare and still queries the table directly.
   */
  private async findExistingVehicle(v: NormalizedVehicle) {
    const byProviderId =
      (await this.providerVehicles(v.providerName)).get(v.providerVehicleId) ??
      null;
    if (byProviderId || !v.imei) return byProviderId;

    const byImei = await this.prisma.vehicle.findFirst({
      where: { providerName: v.providerName, imei: v.imei },
    });
    if (!byImei) return null;

    this.logger.log(
      `Re-keying ${v.vehicleNumber} (${v.providerName}) from ` +
        `providerVehicleId=${byImei.providerVehicleId} to ${v.providerVehicleId} ` +
        `via IMEI — same device, avoided a duplicate row`,
    );
    const rekeyed = await this.prisma.vehicle.update({
      where: { id: byImei.id },
      data: { providerVehicleId: v.providerVehicleId },
    });
    this.rememberVehicle(rekeyed, byImei.providerVehicleId);
    return rekeyed;
  }

  /** One provider's vehicles for this cycle — a single read the first time it is needed. */
  private async providerVehicles(
    providerName: string,
  ): Promise<Map<string, Vehicle>> {
    this.vehiclesByProvider ??= new Map();
    let byId = this.vehiclesByProvider.get(providerName);
    if (!byId) {
      const rows = await this.prisma.vehicle.findMany({
        where: { providerName },
      });
      byId = new Map();
      for (const row of rows) {
        if (row.providerVehicleId) byId.set(row.providerVehicleId, row);
      }
      this.vehiclesByProvider.set(providerName, byId);
    }
    return byId;
  }

  /**
   * Keep the cycle's vehicle set in step with a row this cycle just wrote. `replacedKey` is
   * the provider id a re-key moved the row away from, which must stop matching.
   */
  private rememberVehicle(row: Vehicle, replacedKey?: string | null): void {
    const byId = row.providerName
      ? this.vehiclesByProvider?.get(row.providerName)
      : undefined;
    if (!byId) return;
    if (replacedKey) byId.delete(replacedKey);
    if (row.providerVehicleId) byId.set(row.providerVehicleId, row);
  }

  /**
   * Create rows for vehicles the provider LISTS but that have never sent a position.
   *
   * Transight exposes two endpoints and they disagree: get_all_vehicles returns the full
   * fleet while get_all_vehicles_last_data returns only devices with a recent fix (20 vs
   * 18 on 2026-09-11). The sync was position-first, so a vehicle that had never reported
   * simply never got a row — it was invisible in FleetTrack while plainly present at the
   * provider.
   *
   * Reads ONLY the inventory the adapter already cached while fetching positions, so this
   * makes NO API call and cannot touch the 100/day get_all_vehicles cap. A provider whose
   * inventory IS its positions (AiroTrack) does not implement cachedVehicles(), so the
   * loop body never runs for it.
   *
   * CREATE-ONLY by design: positions own telemetry, inventory only fills gaps. Existing
   * rows are never updated here and never deleted — an absent or partial inventory
   * response must never be read as a delete signal.
   */
  private async syncInventory(provider: GpsProvider): Promise<number> {
    let created = 0;

    for (const v of provider.cachedVehicles?.() ?? []) {
      if (await this.findExistingVehicle(v)) continue;

      const row = await this.prisma.vehicle.create({
        data: {
          vehicleName: v.vehicleNumber,
          vehicleNumber: v.vehicleNumber,
          // imei may be null; the column is not nullable, so fall back to the plate.
          gpsDeviceId: v.gpsDeviceId ?? v.vehicleNumber,
          providerName: v.providerName,
          providerVehicleId: v.providerVehicleId,
          imei: v.imei ?? null,
          driverName: 'Unknown Driver',
          clientId: null, // unassigned global inventory — never auto-assigned
          // This device has NEVER reported a fix. latitude/longitude/speed are left to the
          // column defaults (0/0/0) rather than invented; 0,0 is already this codebase's
          // "no usable fix" sentinel (isValidCoord rejects it, and so does the frontend's
          // isValidCoordinate, so no marker is plotted). status and isOnline are set
          // EXPLICITLY because the schema defaults (IDLE / true) would advertise a vehicle
          // we have never heard from as online. Both timestamps stay null: writing
          // new Date() into lastProviderUpdate would forge freshness out of nothing.
          status: 'OFFLINE',
          isOnline: false,
          lastProviderUpdate: null,
          lastSeenAt: null,
        },
      });
      this.rememberVehicle(row);
      created++;

      this.logger.log(
        `New inventory-only vehicle ${v.vehicleNumber} (${v.providerName}): listed by ` +
          `the provider but has never sent a position — created OFFLINE with no coordinates`,
      );
      // Deliberately no emitVehicleUpdate: broadcasting a vehicle with no position to
      // every connected live map is noise, and no client can render it usefully.
      // Deliberately no recordHistoryAndBreadcrumbs: there is no position to record.
    }

    return created;
  }

  /**
   * Insert a new (unassigned) vehicle or update an existing one, keyed by provider
   * identity (providerName + providerVehicleId) — NOT by clientId, so assignment is
   * preserved. Records location history + trip breadcrumbs and broadcasts the update
   * (scoped: owning client's room + admins; unassigned → admins only).
   *
   * Returns how the position was judged, for the per-provider summary log.
   */
  private async upsertPosition(
    pos: NormalizedPosition,
    pollIntervalSec: number | null | undefined,
  ): Promise<'fresh' | 'stale' | 'untimed' | 'unresolved'> {
    const fixTime = pos.providerTimestamp ?? null;

    // A provider that sends no timestamp at all gives us nothing better to go on than
    // the fact that it just returned this vehicle, so the poll itself is the evidence.
    // Both current providers DO send one, so this is a fallback, not the normal path —
    // and it is deliberately not written to lastProviderUpdate as if it were a real fix.
    const fresh = fixTime
      ? isPositionFresh(fixTime, pollIntervalSec)
      : true;
    const outcome: 'fresh' | 'stale' | 'untimed' = !fixTime
      ? 'untimed'
      : fresh
        ? 'fresh'
        : 'stale';

    const status = this.deriveStatus(pos.ignition, pos.speed, fresh);

    const existing = await this.findExistingVehicle(pos);

    // Nothing matched by provider id OR by IMEI. If the identity we were given is itself a
    // fallback (Transight's inventory cache was empty, so the IMEI is standing in for a
    // vehicle_id we never resolved), we cannot tell a genuinely new vehicle apart from an
    // existing one we simply failed to resolve. Creating on that guess is exactly what
    // produced 12 duplicate rows on 2026-08-14, so defer instead: skip this position and
    // let a later cycle create the vehicle once inventory is back and identity is real.
    // Nothing is lost — the provider re-sends its latest position every poll.
    if (!existing && pos.identityIsFallback) {
      this.logger.warn(
        `Skipping ${pos.vehicleNumber} (${pos.providerName}, imei=${pos.imei ?? 'none'}): ` +
          `no vehicle matches this provider id or IMEI, and the identity is a fallback ` +
          `because the provider inventory was unavailable. Not creating a vehicle on an ` +
          `unproven identity — will retry once inventory recovers.`,
      );
      return 'unresolved';
    }

    if (!existing) {
      const created = await this.prisma.vehicle.create({
        data: {
          vehicleName: pos.vehicleNumber,
          vehicleNumber: pos.vehicleNumber,
          gpsDeviceId: pos.gpsDeviceId ?? pos.vehicleNumber,
          providerName: pos.providerName,
          providerVehicleId: pos.providerVehicleId,
          imei: pos.imei ?? null,
          driverName: 'Unknown Driver',
          clientId: null, // unassigned global inventory — never auto-assigned
          ignition: pos.ignition,
          batteryVoltage: pos.batteryVoltage ?? undefined,
          charge: pos.charge ?? undefined,
          isOnline: fresh,
          status,
          latitude: pos.latitude,
          longitude: pos.longitude,
          speed: pos.speed,
          lastSeenAt: new Date(),
          // Only ever a REAL provider fix time. This used to fall back to `new Date()`,
          // which stamped a vehicle that had not reported in hours as though it had just
          // sent a fix — the exact value every freshness check depends on, forged.
          lastProviderUpdate: fixTime,
        },
      });
      this.rememberVehicle(created);

      this.logger.log(
        `New unassigned inventory vehicle ${pos.vehicleNumber} (${pos.providerName})`,
      );
      this.trackingGateway.emitVehicleUpdate(created);
      return outcome;
    }

    // An OLDER fix must never overwrite a newer one. Both providers re-serve their last
    // known position on every call, so a retry landing out of order — or a device that
    // briefly reports an older buffered fix — would otherwise drag the vehicle back to a
    // previous location and speed. `lastSeenAt` still advances: we did hear from the
    // provider, we just learned nothing newer about the vehicle.
    const isStaleReplay =
      fixTime != null &&
      existing.lastProviderUpdate != null &&
      fixTime.getTime() < existing.lastProviderUpdate.getTime();

    if (isStaleReplay) {
      this.rememberVehicle(
        await this.prisma.vehicle.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date() },
        }),
      );
      return outcome;
    }

    const updated = await this.prisma.vehicle.update({
      where: { id: existing.id },
      // Position/telemetry only — clientId is deliberately absent so assignment is
      // never changed by a sync. Transight lacks battery/charge → undefined = no-op.
      data: {
        ignition: pos.ignition,
        batteryVoltage: pos.batteryVoltage ?? undefined,
        charge: pos.charge ?? undefined,
        imei: pos.imei ?? existing.imei ?? undefined,
        isOnline: fresh,
        status,
        latitude: pos.latitude,
        longitude: pos.longitude,
        speed: pos.speed,
        lastSeenAt: new Date(),
        // Only ever a real fix time — never forged from `new Date()`, which is what
        // used to make an hours-old position look like it had just arrived.
        lastProviderUpdate: fixTime ?? undefined,
      },
    });
    this.rememberVehicle(updated);

    await this.recordHistoryAndBreadcrumbs(updated, pos);

    // Scoped delivery: only the owning client's room + admins (never global).
    this.trackingGateway.emitVehicleUpdate(updated);
    return outcome;
  }

  /**
   * Persist a location-history point (with computed heading) and a trip breadcrumb,
   * gated by the same 10m movement filter as before. Unchanged logic, just factored
   * out of the sync loop so both providers reuse it.
   */
  private async recordHistoryAndBreadcrumbs(
    vehicle: Vehicle,
    pos: NormalizedPosition,
  ): Promise<void> {
    if (!isValidCoord(pos.latitude, pos.longitude)) return;

    const lastHistory = await this.prisma.vehicleLocationHistory.findFirst({
      where: { vehicleId: vehicle.id },
      orderBy: { createdAt: 'desc' },
      // Only the point is compared; the other six columns were read and discarded.
      select: { latitude: true, longitude: true },
    });

    let shouldSave = true;
    let heading = 0;

    if (lastHistory) {
      const dist = haversineDistance(
        lastHistory.latitude,
        lastHistory.longitude,
        pos.latitude,
        pos.longitude,
      );

      if (dist < MIN_SAVE_DISTANCE_METERS) {
        shouldSave = false;
      } else {
        heading = calculateBearing(
          lastHistory.latitude,
          lastHistory.longitude,
          pos.latitude,
          pos.longitude,
        );
      }
    }

    if (!shouldSave) return;

    await this.prisma.vehicleLocationHistory.create({
      data: {
        vehicleId: vehicle.id,
        latitude: pos.latitude,
        longitude: pos.longitude,
        speed: pos.speed,
        ignition: pos.ignition,
        heading,
      },
    });

    await this.recordTripBreadcrumbs(vehicle.id, {
      lat: pos.latitude,
      lng: pos.longitude,
      speed: pos.speed,
      heading,
    });
  }

  /**
   * Mark vehicles offline once their last GPS fix ages out.
   *
   * This used to compare `lastSeenAt` against a flat 5 minutes — but `lastSeenAt` is
   * stamped `new Date()` on every poll, so for any vehicle the provider keeps returning
   * it was permanently 0 seconds old and this sweep could never fire. Only a vehicle
   * that vanished from the feed entirely was ever caught. Freshness now comes from
   * `lastProviderUpdate` (the GPS fix time) against that provider's own window, so a
   * device that is still listed but stopped reporting is correctly marked offline.
   */
  @Cron('0 */1 * * * *')
  async detectOfflineVehicles() {
    try {
      // Per-provider windows — Transight's cadence is 5x AiroTrack's, so a single
      // threshold would either flap Transight or never catch AiroTrack.
      const integrations = await this.prisma.gpsIntegration.findMany({
        select: { provider: true, pollIntervalSec: true },
      });
      const pollByProvider = new Map<string, number>(
        integrations.map((i) => [
          i.provider.toLowerCase(),
          i.pollIntervalSec ?? 300,
        ]),
      );

      const now = Date.now();
      // Only the columns the sweep below actually reads. The vehicle row that gets
      // broadcast is the one `update()` returns further down (still the full row), so
      // the socket payload is unchanged.
      const candidates = await this.prisma.vehicle.findMany({
        where: { isOnline: true },
        select: {
          id: true,
          vehicleNumber: true,
          providerName: true,
          lastProviderUpdate: true,
          lastSeenAt: true,
        },
      });

      for (const vehicle of candidates) {
        const poll = pollByProvider.get(
          (vehicle.providerName ?? '').toLowerCase(),
        );

        // Fall back to lastSeenAt only when we have no GPS fix time at all, so a
        // provider that sends no timestamps keeps the old (poll-based) behaviour.
        const reference = vehicle.lastProviderUpdate ?? vehicle.lastSeenAt;
        if (isPositionFresh(reference, poll, now)) continue;

        const updatedVehicle = await this.prisma.vehicle.update({
          where: { id: vehicle.id },
          data: { isOnline: false, status: 'OFFLINE' },
        });

        // Scoped delivery: only the owning client's room + admins (never global).
        this.trackingGateway.emitVehicleUpdate(updatedVehicle);

        const age = positionAgeMs(reference, now);
        this.logger.warn(
          `Vehicle offline: ${vehicle.vehicleNumber} (last fix ` +
            (age === null
              ? 'unknown/invalid'
              : `${Math.round(age / 60000)}m ago`) +
            `, window ${Math.round(stalenessThresholdMs(poll) / 60000)}m)`,
        );
      }
    } catch (error) {
      if (this.isTransientDbError(error)) {
        this.logger.warn(
          'DB temporarily unreachable — skipping offline detection',
        );
        return;
      }
      this.logger.error(
        'Offline detection failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Active trip ids for one vehicle, from a snapshot taken at most ONCE per sync cycle.
   *
   * The selection is unchanged — a trip counts when it is assigned to this vehicle and
   * its status is in ACTIVE_TRIP_STATUSES — it is just resolved against one fleet-wide
   * read instead of one query per saved history point. Measured on production: the Trip
   * table was queried once for every VehicleLocationHistory row written (25,547 scans
   * for 25,547 rows), every one of them returning nothing.
   *
   * Loaded lazily on the first breadcrumb of the cycle, so a tick in which no vehicle
   * moved far enough to persist still issues zero trip queries, exactly as before.
   */
  private async activeTripIdsFor(vehicleId: string): Promise<string[]> {
    if (!this.activeTripsByVehicle) {
      const trips = await this.prisma.trip.findMany({
        where: { status: { in: ACTIVE_TRIP_STATUSES } },
        select: { id: true, vehicleId: true },
      });

      const byVehicle = new Map<string, string[]>();
      for (const trip of trips) {
        // vehicleId is nullable (an unassigned trip); such a trip matched no vehicle
        // under the old per-vehicle WHERE either, so it is skipped here too.
        if (!trip.vehicleId) continue;
        const existing = byVehicle.get(trip.vehicleId);
        if (existing) existing.push(trip.id);
        else byVehicle.set(trip.vehicleId, [trip.id]);
      }

      this.activeTripsByVehicle = byVehicle;
    }

    return this.activeTripsByVehicle.get(vehicleId) ?? [];
  }

  /**
   * Append a GPS breadcrumb to every trip this vehicle is actively running, so a
   * completed trip can later replay its real travelled route. Called only when the
   * vehicle has moved far enough to persist (reuses the location-history filter).
   */
  private async recordTripBreadcrumbs(
    vehicleId: string,
    point: { lat: number; lng: number; speed: number; heading: number },
  ) {
    try {
      const activeTripIds = await this.activeTripIdsFor(vehicleId);

      if (activeTripIds.length === 0) return;

      await this.prisma.tripBreadcrumb.createMany({
        data: activeTripIds.map((tripId) => ({
          tripId,
          latitude: point.lat,
          longitude: point.lng,
          speed: point.speed,
          heading: point.heading,
        })),
      });
    } catch (error) {
      // Breadcrumb recording is secondary — never let it disrupt vehicle sync or
      // the live location broadcast. The next tick retries.
      this.logger.warn(
        `Failed to record trip breadcrumbs for vehicle ${vehicleId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
