import { IsDateString, IsOptional } from 'class-validator';

/**
 * Customer delivery report query (RPT-06.1). Optional date range narrows trips by
 * scheduledStart. No clientId field: customers are tenant-owned, so the report is
 * CLIENT-only and always pinned to the authenticated client's own trips (mirrors the
 * customers module) — unlike the trip/driver/vehicle reports an ADMIN may scope.
 */
export class CustomerReportQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
