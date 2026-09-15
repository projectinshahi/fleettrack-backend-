import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Proof-of-delivery record upsert (POD-01 / POD-03). All fields optional — a partial
 * save never clears the others; setting `deliveredAt` confirms the delivery. Proof
 * media (photos/signature) is uploaded separately through the shared /uploads API.
 *
 * POD-04.1/04.2 — the delivery geolocation (captured client-side on confirmation) is
 * accepted here and validated to real coordinate ranges; never trusted blindly.
 */
export class UpsertPodDto {
  @IsOptional()
  @IsString()
  recipientName?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  deliveredAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  deliveredLat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  deliveredLng?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deliveredLocationAccuracy?: number;
}
