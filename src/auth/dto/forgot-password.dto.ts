import { IsEmail } from 'class-validator';

/** Request a password reset link for an account email (User or Client). */
export class ForgotPasswordDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  email: string;
}
