import { TripCost } from '@prisma/client';

/**
 * The fixed cost components and their TripCost fields, in one place so the report
 * aggregation (TCM-05) reads the same set the variance uses. `as const` keeps the
 * field names as literal keys of TripCost.
 */
export const COST_COMPONENTS = [
  { key: 'fuel', estimated: 'estimatedFuel', actual: 'actualFuel' },
  { key: 'tolls', estimated: 'estimatedTolls', actual: 'actualTolls' },
  {
    key: 'allowance',
    estimated: 'estimatedAllowance',
    actual: 'actualAllowance',
  },
  { key: 'parking', estimated: 'estimatedParking', actual: 'actualParking' },
  {
    key: 'maintenance',
    estimated: 'estimatedMaintenance',
    actual: 'actualMaintenance',
  },
  { key: 'misc', estimated: 'estimatedMisc', actual: 'actualMisc' },
] as const;

/**
 * Cost variance (TCM-04) — pure, derived from the existing TripCost (actual −
 * estimated) per component plus the per-trip totals. Never persisted; computed on
 * read and returned alongside the cost so there is no separate variance endpoint.
 * Reusable by the cost report (TCM-05).
 */
export interface CostVariance {
  fuel: number;
  tolls: number;
  allowance: number;
  parking: number;
  maintenance: number;
  misc: number;
  estimatedTotal: number;
  actualTotal: number;
  total: number;
}

export function computeCostVariance(cost: TripCost | null): CostVariance {
  const estimated = {
    fuel: cost?.estimatedFuel ?? 0,
    tolls: cost?.estimatedTolls ?? 0,
    allowance: cost?.estimatedAllowance ?? 0,
    parking: cost?.estimatedParking ?? 0,
    maintenance: cost?.estimatedMaintenance ?? 0,
    misc: cost?.estimatedMisc ?? 0,
  };
  const actual = {
    fuel: cost?.actualFuel ?? 0,
    tolls: cost?.actualTolls ?? 0,
    allowance: cost?.actualAllowance ?? 0,
    parking: cost?.actualParking ?? 0,
    maintenance: cost?.actualMaintenance ?? 0,
    misc: cost?.actualMisc ?? 0,
  };

  const estimatedTotal =
    estimated.fuel +
    estimated.tolls +
    estimated.allowance +
    estimated.parking +
    estimated.maintenance +
    estimated.misc;
  const actualTotal =
    actual.fuel +
    actual.tolls +
    actual.allowance +
    actual.parking +
    actual.maintenance +
    actual.misc;

  return {
    fuel: actual.fuel - estimated.fuel,
    tolls: actual.tolls - estimated.tolls,
    allowance: actual.allowance - estimated.allowance,
    parking: actual.parking - estimated.parking,
    maintenance: actual.maintenance - estimated.maintenance,
    misc: actual.misc - estimated.misc,
    estimatedTotal,
    actualTotal,
    total: actualTotal - estimatedTotal,
  };
}
