import {
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/**
 * Admin-created client (a CLIENT login principal) + the vehicles to assign to it.
 * No GPS credentials are ever accepted here — provider credentials stay backend-only
 * in GpsIntegration. The password is hashed server-side and never returned.
 */
export class CreateClientDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  // Vehicle IDs to assign at creation (may be empty). Each must exist and be unassigned.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vehicleIds?: string[];
}
