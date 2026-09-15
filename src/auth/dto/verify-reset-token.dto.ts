import { IsNotEmpty, IsString } from 'class-validator';

/** Check whether a reset token is still valid (exists, unused, not expired). */
export class VerifyResetTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}
