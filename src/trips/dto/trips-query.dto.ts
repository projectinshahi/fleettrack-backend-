import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TripStatus } from '@prisma/client';

/**
 * Query for the trip list (GET /trips). Every filter is optional, so a request without
 * them behaves exactly as it did before this DTO existed.
 *
 * `status` takes one value or a comma-separated list — `?status=ONGOING` or
 * `?status=STARTED,ONGOING,DELAYED` — so the dashboard can ask for just the in-transit
 * set instead of downloading every trip and filtering it in the browser. An unknown
 * value is rejected by the global ValidationPipe as a 400, like any other bad query.
 */
export class TripsQueryDto {
  // ADMIN only: narrows to the selected client. Ignored for a CLIENT, which findAll pins
  // to its own trips via the JWT — so this can never be used to read another tenant.
  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsEnum(TripStatus, { each: true })
  status?: TripStatus[];
}
