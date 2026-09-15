import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Vehicle utilization report query (RPT-03.1). Optional date range narrows trips by
 * scheduledStart AND defines the utilization window; an ADMIN may scope to one client
 * (a CLIENT is always pinned to its own trips). Mirrors DriverReportQueryDto — each
 * per-module report keeps its own small query DTO rather than cross-importing.
 */
export class VehicleReportQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  clientId?: string;
}
