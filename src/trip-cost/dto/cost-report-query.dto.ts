import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Cost report query (TCM-05.1). Optional date range narrows trips by scheduledStart;
 * an ADMIN may scope to one client (a CLIENT is always pinned to its own trips).
 */
export class CostReportQueryDto {
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
