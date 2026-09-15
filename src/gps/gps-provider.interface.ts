// Normalized shapes that BOTH providers map into, so the sync never sees a
// provider-specific payload. Provider-specific parsing stays in the adapters;
// vehicle persistence is never duplicated inside a provider.

export type GpsProviderKey = 'airotrack' | 'transight';

export interface NormalizedVehicle {
  providerName: GpsProviderKey;
  /** Stable provider identity. AiroTrack: vehicleNumber. Transight: vehicle_id. */
  providerVehicleId: string;
  /** Display number plate. */
  vehicleNumber: string;
  /** Transight device IMEI; AiroTrack has none (null). */
  imei?: string | null;
  gpsDeviceId?: string | null;
}

export interface NormalizedPosition extends NormalizedVehicle {
  latitude: number;
  longitude: number;
  speed: number;
  ignition: boolean;
  /**
   * AiroTrack-only extras. Transight does NOT provide power/charge/battery —
   * these are left null there and never invented.
   */
  batteryVoltage?: number | null;
  charge?: boolean | null;
  /** Provider "last_updated" / "time" as a UTC Date, or null if absent/unparseable. */
  providerTimestamp?: Date | null;
  /**
   * True when `providerVehicleId` is NOT the provider's own vehicle id but a substitute
   * the adapter had to fall back to (Transight positions carry no vehicle_id, so the IMEI
   * stands in whenever the inventory cache can't resolve one).
   *
   * The sync treats a fallback identity as "unproven": it will happily UPDATE a vehicle it
   * can match by IMEI, but it will not CREATE a new row on that basis, because a cold
   * cache cannot distinguish "genuinely new vehicle" from "existing vehicle we failed to
   * resolve" — and guessing wrong is what produced 12 duplicate rows in production.
   *
   * Absent/false for AiroTrack, whose positions always carry their own stable identity.
   */
  identityIsFallback?: boolean;
}

/**
 * Upper bound on ONE provider HTTP call. Without it, Node's fetch waits up to 300 s for
 * response headers (undici's default), and the sync polls providers one after another behind
 * a single reentrancy guard: one stalled provider held the whole tick, so the other provider
 * was not polled either while the offline sweep kept aging its vehicles out. Reproduced
 * locally: a bare fetch() to an endpoint that accepts and never answers was still pending
 * after 65 s. 20 s is far above a healthy call and keeps both providers inside one 60 s tick
 * even if both time out.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;

/** Rewrite a fetch aborted by its timeout into an error naming the provider and the limit. */
export function providerRequestError(
  error: unknown,
  provider: string,
  timeoutMs: number,
): unknown {
  return (error as { name?: string } | null)?.name === 'TimeoutError'
    ? new Error(`${provider} request timed out after ${timeoutMs} ms`)
    : error;
}

export interface GpsProviderConfig {
  baseUrl: string;
  /** token (AiroTrack) or apikey (Transight). Never logged or serialized. */
  credential: string;
  system?: string | null;
  /** Per-call timeout; PROVIDER_REQUEST_TIMEOUT_MS unless set (only tests set it). */
  timeoutMs?: number;
}

export interface GpsProvider {
  readonly name: GpsProviderKey;
  /** Identity/inventory list (no position needed). */
  getVehicles(): Promise<NormalizedVehicle[]>;
  /** Latest positions for all vehicles (bulk). */
  getLatestPositions(): Promise<NormalizedPosition[]>;
  /**
   * Inventory the adapter ALREADY holds in memory — makes no API call.
   *
   * Only a provider with a SEPARATE inventory endpoint implements this. Transight's
   * get_all_vehicles lists vehicles that get_all_vehicles_last_data may omit, so the
   * sync needs the full list to create rows for devices that have never sent a fix.
   *
   * Optional on purpose: AiroTrack's inventory IS its positions (its getVehicles() is
   * getLatestPositions() plus a map — a second full HTTP GET), so it deliberately does
   * NOT implement this and the sync's gap-fill pass becomes a no-op for it. That is how
   * a provider opts out structurally, instead of the service branching on provider name.
   */
  cachedVehicles?(): NormalizedVehicle[];
}
