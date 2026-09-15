import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Trip summary report query (RPT-01.1). Optional date range narrows trips by
 * scheduledStart; an ADMIN may scope to one client (a CLIENT is always pinned to
 * its own trips). Mirrors CostReportQueryDto — each per-module report keeps its own
 * small query DTO rather than cross-importing.
 */
export class TripReportQueryDto {
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
