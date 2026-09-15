import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CostComponent, FileCategory } from '@prisma/client';

/**
 * List query for a trip's files. `tripId` is required (files are always listed per
 * owning trip); `category` optionally narrows to one kind (e.g. only receipts), and
 * `costComponent` (TCM-03.2) optionally narrows receipts to one cost component.
 */
export class UploadQueryDto {
  @IsString()
  tripId: string;

  @IsOptional()
  @IsEnum(FileCategory)
  category?: FileCategory;

  @IsOptional()
  @IsEnum(CostComponent)
  costComponent?: CostComponent;
}
