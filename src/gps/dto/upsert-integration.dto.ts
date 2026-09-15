import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpsertIntegrationDto {
  @IsBoolean()
  active: boolean;

  @IsString()
  baseUrl: string;

  // Transight only: "COMPASS" | "DISCOVERY" (informational).
  @IsOptional()
  @IsString()
  system?: string;

  // Secret (token/apikey). Only overwritten when provided; never returned on reads.
  @IsOptional()
  @IsString()
  credential?: string;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86400)
  pollIntervalSec?: number;
}
