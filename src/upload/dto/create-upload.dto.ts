import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CostComponent, FileCategory } from '@prisma/client';

/**
 * Multipart text fields accompanying an upload. `category` is the generic
 * discriminator (RECEIPT / POD_*) the owning module supplies; `tripId` is the owner
 * link. The file part itself is validated by ParseFilePipe in the controller.
 */
export class CreateUploadDto {
  @IsEnum(FileCategory)
  category: FileCategory;

  @IsString()
  tripId: string;

  // TCM-03.2 — optional cost component a RECEIPT is attached to (validated against the
  // enum). Omitted for POD media and general/trip-level receipts.
  @IsOptional()
  @IsEnum(CostComponent)
  costComponent?: CostComponent;
}
