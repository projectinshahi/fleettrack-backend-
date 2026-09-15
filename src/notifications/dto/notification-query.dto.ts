import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Notification list query. `unread=true` narrows to unread only; `limit` caps the page
 * (a service default applies otherwise). Small per-module DTO, mirroring the report DTOs.
 */
export class NotificationQueryDto {
  @IsOptional()
  @IsString()
  unread?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
