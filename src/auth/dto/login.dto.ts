import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Login body. It exists so a malformed body is a 400 at the edge: with `@Body() body: any`
 * a non-string value went straight into the Prisma lookup and answered 500. `email` is a
 * non-empty string, deliberately not @IsEmail — this DTO must never reject a credential
 * that could log in before.
 */
export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password: string;
}
