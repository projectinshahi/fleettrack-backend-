import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CreateTripStopDto,
  MAX_ADDRESS_LENGTH,
  MAX_TRIP_STOPS,
} from './create-trip.dto';

export class UpdateTripDto {
  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  driverId?: string;

  @IsOptional()
  @IsString()
  driverName?: string;

  // Customer this trip is for (CUS-07) — optional link.
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ADDRESS_LENGTH)
  origin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ADDRESS_LENGTH)
  destination?: string;

  // TM-05.1: the full ordered stop list. When present, replaces the trip's stops
  // (add / remove / reorder in one write); the server re-sequences and geocodes.
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

  @IsOptional()
  @IsDateString()
  scheduledStart?: string;

  @IsOptional()
  @IsDateString()
  scheduledEnd?: string;

  @IsOptional()
  @IsString()
  notes?: string;

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
