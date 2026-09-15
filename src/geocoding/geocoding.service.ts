import { Injectable, Logger } from '@nestjs/common';

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Address → coordinates, the single source of truth for geocoding across the API
 * (trip creation/update and the /geocode endpoint the frontend uses for route
 * preview + optimization).
 *
 * Provider: OpenStreetMap Nominatim by default (no API key). If GOOGLE_MAPS_API_KEY
 * is set, the Google Geocoding API is used instead. Results are cached in-process
 * and looked up sequentially so we stay within provider rate limits. Geocoding
 * never throws to callers — an unresolved address resolves to null so a provider
 * outage degrades gracefully instead of blocking a trip.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  /** Successful lookups only (so transient failures are retried next time). */
  private readonly cache = new Map<string, GeoPoint>();

  private readonly googleKey = process.env.GOOGLE_MAPS_API_KEY;
  private readonly nominatimUrl =
    process.env.GEOCODER_BASE_URL ??
    'https://nominatim.openstreetmap.org/search';
  private readonly userAgent =
    process.env.GEOCODER_USER_AGENT ?? 'FleetTrack/1.0 (trip management)';

  /** Resolve one address, or null if it can't be geocoded. Cached. */
  async geocode(address: string): Promise<GeoPoint | null> {
    const key = address.trim().toLowerCase();
    if (!key) return null;

    const cached = this.cache.get(key);
    if (cached) return cached;

    let point: GeoPoint | null = null;
    try {
      point = this.googleKey
        ? await this.geocodeGoogle(address)
        : await this.geocodeNominatim(address);
    } catch (err) {
      this.logger.warn(
        `Geocoding failed for "${address}": ${(err as Error).message}`,
      );
      point = null;
    }

    if (point) this.cache.set(key, point);
    return point;
  }

  /**
   * Resolve many addresses in input order. Sequential (not parallel) to respect
   * the public Nominatim usage policy; cached lookups return immediately.
   */
  async geocodeMany(addresses: string[]): Promise<(GeoPoint | null)[]> {
    const out: (GeoPoint | null)[] = [];
    for (const address of addresses) {
      out.push(await this.geocode(address));
    }
    return out;
  }

  private async geocodeNominatim(address: string): Promise<GeoPoint | null> {
    const url = `${this.nominatimUrl}?format=jsonv2&limit=1&q=${encodeURIComponent(
      address,
    )}`;
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) return null;

    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!Array.isArray(data) || data.length === 0) return null;

    const lat = Number(data[0].lat);
    const lng = Number(data[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng };
  }

  private async geocodeGoogle(address: string): Promise<GeoPoint | null> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      address,
    )}&key=${this.googleKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      status: string;
      results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
    };
    if (data.status !== 'OK' || !data.results?.length) return null;

    const { lat, lng } = data.results[0].geometry.location;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return { lat, lng };
  }
}
