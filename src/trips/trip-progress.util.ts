/**
 * Server-side route progress maths — the canonical implementation of the trip
 * progress / deviation computation the frontend prototyped. Pure functions.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RouteProgressResult {
  totalMeters: number;
  coveredMeters: number;
  remainingMeters: number;
  percentage: number;
  deviationMeters: number;
}

const EARTH_RADIUS_M = 6371000;

export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function routeTotalDistance(points: GeoPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineDistance(
      points[i].lat,
      points[i].lng,
      points[i + 1].lat,
      points[i + 1].lng,
    );
  }
  return total;
}

/** Clamped projection fraction of P onto segment A→B + perpendicular distance. */
function projectFraction(a: GeoPoint, b: GeoPoint, p: GeoPoint) {
  const R = EARTH_RADIUS_M;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(a.lat));

  const bx = R * toRad(b.lng - a.lng) * cosLat;
  const by = R * toRad(b.lat - a.lat);
  const px = R * toRad(p.lng - a.lng) * cosLat;
  const py = R * toRad(p.lat - a.lat);

  const segLen2 = bx * bx + by * by;
  let t = segLen2 === 0 ? 0 : (px * bx + py * by) / segLen2;
  t = Math.max(0, Math.min(1, t));

  const distToSegment = Math.hypot(px - t * bx, py - t * by);
  return { t, distToSegment };
}

export function computeRouteProgress(
  points: GeoPoint[],
  position: GeoPoint | null,
): RouteProgressResult {
  const total = routeTotalDistance(points);

  if (!position || points.length < 2 || total === 0) {
    return {
      totalMeters: total,
      coveredMeters: 0,
      remainingMeters: total,
      percentage: 0,
      deviationMeters: 0,
    };
  }

  let cumulative = 0;
  let bestCovered = 0;
  let bestDist = Infinity;

  for (let i = 0; i < points.length - 1; i++) {
    const segLen = haversineDistance(
      points[i].lat,
      points[i].lng,
      points[i + 1].lat,
      points[i + 1].lng,
    );
    const { t, distToSegment } = projectFraction(
      points[i],
      points[i + 1],
      position,
    );

    if (distToSegment < bestDist) {
      bestDist = distToSegment;
      bestCovered = cumulative + t * segLen;
    }
    cumulative += segLen;
  }

  const covered = Math.max(0, Math.min(bestCovered, total));
  const remaining = Math.max(0, total - covered);
  const percentage = Math.round((covered / total) * 100);

  return {
    totalMeters: total,
    coveredMeters: covered,
    remainingMeters: remaining,
    percentage,
    deviationMeters: Number.isFinite(bestDist) ? bestDist : 0,
  };
}
