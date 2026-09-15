import { IsDateString, IsIn, IsOptional } from 'class-validator';

/**
 * Query params for the delay aggregation endpoint (DLY-04.1). All optional:
 * `period` sets the reporting-period granularity (defaults to month); `from`/`to`
 * narrow the `reportedAt` range. Everything else (category/driver/route buckets)
 * is derived from the existing Delay + Trip data — no schema changes.
 */
export class DelayStatsQueryDto {
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  period?: 'day' | 'week' | 'month';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
