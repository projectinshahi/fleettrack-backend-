import { IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Upsert a trip's cost breakdown (TCM-01.2 estimated / TCM-02.1 actual). Every
 * field is optional so a form can save just the estimated group (this batch) or
 * just the actual group (Batch 2) without clearing the other — one endpoint serves
 * both, so there is no duplicate cost API.
 */
export class UpsertTripCostDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedFuel?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedTolls?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedAllowance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedParking?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedMaintenance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedMisc?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  actualFuel?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  actualTolls?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  actualAllowance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  actualParking?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  actualMaintenance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  actualMisc?: number;
}
