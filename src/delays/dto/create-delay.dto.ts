import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { DelayCategory } from '@prisma/client';

/**
 * Ingest payload for a field-reported delay (DLY-01.1). Kept reusable for the
 * future Driver App: it may supply the field `reportedAt`, `source` and
 * `reportedBy`; the Admin Portal simply omits them (server defaults apply).
 */
export class CreateDelayDto {
  @IsString()
  @IsNotEmpty()
  tripId: string;

  @IsEnum(DelayCategory)
  category: DelayCategory;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  remarks?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMinutes?: number;

  @IsOptional()
  @IsDateString()
  reportedAt?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  reportedBy?: string;
}
