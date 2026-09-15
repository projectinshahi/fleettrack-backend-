import {
  GpsProvider,
  GpsProviderConfig,
  NormalizedPosition,
  NormalizedVehicle,
  PROVIDER_REQUEST_TIMEOUT_MS,
  providerRequestError,
} from './gps-provider.interface';

/**
 * AiroTrack adapter. GET {baseUrl}?token={credential} → flat JSON array of positions.
 * Confirmed live shape (this account, 15 vehicles):
 *   { vehicleNumber, last_updated, lat, long, speed, ignition, power, charge }
 * Preserves the original FleetTrack field mapping; only the transport moved behind
 * the provider interface (global config instead of per-client apiUrl).
 */
export class AiroTrackAdapter implements GpsProvider {
  readonly name = 'airotrack' as const;

  constructor(private config: GpsProviderConfig) {}

  setConfig(config: GpsProviderConfig): void {
    this.config = config;
  }

  private buildUrl(): string {
    // baseUrl may already carry the token (legacy AIROTRACK_API env) or be a bare
    // positionsByToken URL — only append the credential when it isn't present.
    const url = this.config.baseUrl;
    if (/[?&]token=/.test(url)) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(this.config.credential)}`;
  }

  private async fetchRaw(): Promise<unknown[]> {
    // The signal bounds the body read too, not just the headers.
    const timeoutMs = this.config.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS;
    try {
      const res = await fetch(this.buildUrl(), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`AiroTrack HTTP ${res.status}`);
      const json: unknown = await res.json();
      return Array.isArray(json) ? json : [];
    } catch (e) {
      throw providerRequestError(e, 'AiroTrack', timeoutMs);
    }
  }

  /** Pure mapping of one AiroTrack row → NormalizedPosition (unit-tested). */
  static normalizePosition(item: any): NormalizedPosition | null {
    const vehicleNumber = item?.vehicleNumber;
    if (!vehicleNumber) return null;
    const id = String(vehicleNumber);
    return {
      providerName: 'airotrack',
      providerVehicleId: id,
      vehicleNumber: id,
      imei: null,
      gpsDeviceId: id,
      latitude: Number(item.lat) || 0,
      longitude: Number(item.long) || 0,
      speed: Number(item.speed) || 0,
      ignition: Boolean(item.ignition),
      batteryVoltage: item.power != null ? Number(item.power) || 0 : null,
      charge: item.charge != null ? Boolean(item.charge) : null,
      providerTimestamp: AiroTrackAdapter.parseTimestamp(item.last_updated),
    };
  }

  static parseTimestamp(raw: unknown): Date | null {
    if (!raw) return null;
    const d = new Date(raw as string);
    return isNaN(d.getTime()) ? null : d;
  }

  async getLatestPositions(): Promise<NormalizedPosition[]> {
    const raw = await this.fetchRaw();
    return raw
      .map((i) => AiroTrackAdapter.normalizePosition(i))
      .filter((v): v is NormalizedPosition => v !== null);
  }

  async getVehicles(): Promise<NormalizedVehicle[]> {
    // AiroTrack has no separate inventory endpoint — identity comes from positions.
    const positions = await this.getLatestPositions();
    return positions.map((p) => ({
      providerName: p.providerName,
      providerVehicleId: p.providerVehicleId,
      vehicleNumber: p.vehicleNumber,
      imei: p.imei,
      gpsDeviceId: p.gpsDeviceId,
    }));
  }
}
