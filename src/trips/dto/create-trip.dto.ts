import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Every stop and route address is geocoded server-side, one outbound geocoding request per
 * unique address, so an unbounded `stops` array or address string was an unbounded fan-out
 * from a single request. The admin UI caps a trip at 10 stops; 25 leaves headroom for API
 * callers without being unbounded.
 */
export const MAX_TRIP_STOPS = 25;
export const MAX_ADDRESS_LENGTH = 500;

export class CreateTripStopDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ADDRESS_LENGTH)
  address: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;
}

export class CreateTripDto {
  @IsOptional()
  @IsString()
  reference?: string;

  // Ignored for a CLIENT (owner derived from the JWT); accepted for API shape.
  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  driverId?: string;

  @IsOptional()
  @IsString()
  driverName?: string;

  // Optional at the DTO layer because the same DTO serves the CLIENT trip-request path
  // (which carries no driver at all) and the ADMIN direct-create path (which requires
  // one). TripsService.create enforces both for ADMIN, mirroring how clientId is
  // optional here but required for an ADMIN via resolveAdminTargetClient.
  @IsOptional()
  @IsString()
  driverPhone?: string;

  // Customer this trip is for (CUS-07) — optional link.
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ADDRESS_LENGTH)
  origin: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ADDRESS_LENGTH)
  destination: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TRIP_STOPS)
  @ValidateNested({ each: true })
  @Type(() => CreateTripStopDto)
  stops?: CreateTripStopDto[];

  @IsOptional()
  @IsNumber()
  distanceKm?: number;

  @IsOptional()
  @IsNumber()
  durationMins?: number;

  @IsDateString()
  scheduledStart: string;

  @IsDateString()
  scheduledEnd: string;

  @IsOptional()
  @IsString()
  notes?: string;

  // Geocoded coordinates (optional; enables progress/route on the server).
  @IsOptional()
  @IsNumber()
  originLat?: number;

  @IsOptional()
  @IsNumber()
  originLng?: number;

  @IsOptional()
  @IsNumber()
  destinationLat?: number;

  @IsOptional()
  @IsNumber()
  destinationLng?: number;
}
