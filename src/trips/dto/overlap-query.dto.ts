import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Query for the resource double-booking check (GET /trips/overlap). Exactly one of
 * vehicleId / driverId is expected; `start` and `end` bound the candidate window,
 * and `excludeTripId` drops a trip from its own check when editing.
 */
export class OverlapQueryDto {
  // ADMIN only: the selected client the check is scoped to. Ignored for a CLIENT (which is
  // pinned to its own trips via the JWT), so it can never be used to read another tenant.
  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  driverId?: string;

  @IsDateString()
  start: string;

  @IsDateString()
  end: string;

  @IsOptional()
  @IsString()
  excludeTripId?: string;
}
