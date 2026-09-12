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

export interface GpsProviderConfig {
  baseUrl: string;
  /** token (AiroTrack) or apikey (Transight). Never logged or serialized. */
  credential: string;
  system?: string | null;
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
