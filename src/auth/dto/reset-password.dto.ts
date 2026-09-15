import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/** Set a new password using a valid reset token. */
export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;
}
