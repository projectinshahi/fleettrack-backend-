export type VehicleStatus = 'MOVING' | 'IDLE' | 'OFFLINE';

/**
 * The single authoritative reading of a vehicle's current status.
 *
 * FleetTrack has exactly ONE place that decides status: TrackingService, which derives it
 * from the age of the provider's GPS fix (see gps-freshness.ts) and persists the result to
 * Vehicle.status / Vehicle.isOnline. Everything else READS that decision — nothing
 * recomputes it.
 *
 * This replaces a second, independent implementation that took (ignition, speed) and
 * never looked at time at all:
 *
 *     if (speed > 0) return 'MOVING';                    // stale speed counted as moving
 *     if (ignition && speed === 0) return 'IDLE';
 *     return 'OFFLINE';                                  // really meant "engine off"
 *
 * Because it ignored freshness entirely, a device dead for a month but frozen with
 * speed=13.2 was reported MOVING on the dashboard while /tracking correctly showed it
 * OFFLINE — the same vehicle, two answers. KL85B1418 was exactly that case.
 *
 * `status` and `isOnline` are written together by TrackingService and cannot legitimately
 * disagree. If they ever do, one of them is stale, so the safe reading wins: a vehicle is
 * treated as OFFLINE when EITHER says so. That keeps a stale vehicle from being counted
 * as active during the ≤60s window between a fix ageing out and the next
 * detectOfflineVehicles sweep, without duplicating any freshness logic here.
 */
export function effectiveVehicleStatus(vehicle: {
  status: string;
  isOnline: boolean;
}): VehicleStatus {
  if (!vehicle.isOnline) return 'OFFLINE';
  if (vehicle.status === 'MOVING') return 'MOVING';
  if (vehicle.status === 'IDLE') return 'IDLE';
  return 'OFFLINE';
}
