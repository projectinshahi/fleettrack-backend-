/**
 * Nearest-neighbour stop ordering (TM-06.2) — pure, no external services.
 *
 * Computes an optimised visiting order for a trip's intermediate stops with the
 * pickup (origin) and destination FIXED as the route endpoints, minimising total
 * straight-line (Haversine) distance with a greedy nearest-neighbour heuristic.
 * This is the local approximation used until a real Google Routes integration
 * (TM-06.1) is added; it deliberately reuses trip-progress.util's Haversine so the
 * distance maths is not duplicated, and mirrors the concept the frontend prototyped
 * in lib/route-optimize.
 */
import {
  GeoPoint,
  haversineDistance,
  routeTotalDistance,
} from './trip-progress.util';

export interface StopOptimizationResult {
  /** Optimised visiting order as indices into the original `stops` array. */
  order: number[];
  /** Total origin→stops→destination distance before optimisation (metres). */
  originalDistanceMeters: number;
  /** Total origin→stops→destination distance after optimisation (metres). */
  optimizedDistanceMeters: number;
}

const distance = (a: GeoPoint, b: GeoPoint): number =>
  haversineDistance(a.lat, a.lng, b.lat, b.lng);

/**
 * Greedy nearest-neighbour ordering of `stops` between the fixed `origin` and
 * `destination`. Returns the order as original indices; the endpoints stay put and
 * only the intermediate stops are reordered. Deterministic — ties resolve to the
 * lower original index.
 */
export function optimizeStopOrder(
  origin: GeoPoint,
  _destination: GeoPoint,
  stops: GeoPoint[],
): number[] {
  const remaining = stops.map((_, i) => i);
  const order: number[] = [];
  let current = origin;

  while (remaining.length > 0) {
    let bestPos = 0;
    let bestDist = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const d = distance(current, stops[remaining[k]]);
      if (d < bestDist) {
        bestDist = d;
        bestPos = k;
      }
    }
    const [chosen] = remaining.splice(bestPos, 1);
    order.push(chosen);
    current = stops[chosen];
  }

  return order;
}

/**
 * Full optimisation: the reordered indices plus the before/after total route
 * distance (origin → stops → destination), so callers can report the saving.
 */
export function computeStopOptimization(
  origin: GeoPoint,
  destination: GeoPoint,
  stops: GeoPoint[],
): StopOptimizationResult {
  const order = optimizeStopOrder(origin, destination, stops);
  const originalDistanceMeters = routeTotalDistance([
    origin,
    ...stops,
    destination,
  ]);
  const optimizedDistanceMeters = routeTotalDistance([
    origin,
    ...order.map((i) => stops[i]),
    destination,
  ]);
  return { order, originalDistanceMeters, optimizedDistanceMeters };
}
