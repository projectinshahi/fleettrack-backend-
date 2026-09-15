import { Role } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  MinLength,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}