import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { MailService } from '../mail/mail.service';

/** How long a password reset link stays valid. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Cost factor for hashing the new password (matches typical bcrypt defaults). */
const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mail: MailService,
  ) {}

  async login(body: any) {
    const { email, password } = body;

    let account: any =
      await this.prisma.user.findUnique({
        where: { email },
      });

    let accountType = 'USER';

    if (!account) {
      account =
        await this.prisma.client.findUnique({
          where: { email },
        });

      accountType = 'CLIENT';
    }

    // One message for an unknown account and a wrong password. Two different messages told
    // a caller which emails have accounts, which is the first step of guessing passwords.
    if (!account) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    const isPasswordValid =
      await bcrypt.compare(
        password,
        account.password,
      );

    if (!isPasswordValid) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    const token = this.jwtService.sign({
      userId: account.id,
      role:
        accountType === 'CLIENT'
          ? 'CLIENT'
          : account.role,
      accountType,
    });

    // Strip BOTH the password hash and (for a Client) the apiUrl — the apiUrl encodes the
    // provider GPS credential and must never reach the browser / localStorage.
    const { password: _password, apiUrl: _apiUrl, ...safeAccount } =
      account;

    const normalizedUser = {
      ...safeAccount,
      role:
        accountType === 'CLIENT'
          ? 'CLIENT'
          : safeAccount.role,
    };

    return {
      success: true,
      token,
      user: normalizedUser,
      accountType,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Password reset                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Start a password reset (POST /auth/forgot-password). Resolves the account the same
   * way login does (a User first, then a Client) and, if found, issues a single-use,
   * time-limited token. The response is ALWAYS a generic success so the endpoint can't
   * be used to enumerate which emails have accounts.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const accountType = await this.resolveAccountType(email);

    if (accountType) {
      // Invalidate any outstanding tokens for this email before issuing a new one.
      await this.prisma.passwordResetToken.deleteMany({ where: { email } });

      const rawToken = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

      await this.prisma.passwordResetToken.create({
        data: {
          tokenHash: this.hashToken(rawToken),
          email,
          accountType,
          expiresAt,
        },
      });

      const resetUrl = `${this.frontendUrl()}/reset-password?token=${rawToken}`;
      await this.mail.sendPasswordResetEmail({
        to: email,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_TTL_MS / 60000,
      });
    }

    return {
      success: true,
      message:
        'If an account exists for this email, a password reset link has been sent.',
    };
  }

  /**
   * Check a token without consuming it (GET /auth/verify-reset-token) so the reset page
   * can show the form or an "expired link" message before the user types anything.
   */
  async verifyResetToken(token: string) {
    const record = await this.getValidResetToken(token);
    return { success: true, valid: !!record };
  }

  /**
   * Complete a reset (POST /auth/reset-password): validate the token, hash and store the
   * new password on the correct principal (User or Client), then consume the token.
   */
  async resetPassword(dto: ResetPasswordDto) {
    const record = await this.getValidResetToken(dto.token);

    if (!record) {
      throw new BadRequestException(
        'This password reset link is invalid or has expired.',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    if (record.accountType === 'CLIENT') {
      await this.prisma.client.update({
        where: { email: record.email },
        data: { password: passwordHash },
      });
    } else {
      await this.prisma.user.update({
        where: { email: record.email },
        data: { password: passwordHash },
      });
    }

    // Consume this token and drop any siblings so the link can't be reused.
    await this.prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    await this.prisma.passwordResetToken.deleteMany({
      where: { email: record.email, id: { not: record.id } },
    });

    return {
      success: true,
      message: 'Your password has been reset. You can now log in.',
    };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /** 'USER' if a User owns the email, 'CLIENT' if a Client does, else null. */
  private async resolveAccountType(
    email: string,
  ): Promise<'USER' | 'CLIENT' | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user) return 'USER';
    const client = await this.prisma.client.findUnique({ where: { email } });
    if (client) return 'CLIENT';
    return null;
  }

  /** A reset token row that exists, is unused, and has not expired; else null. */
  private async getValidResetToken(token: string) {
    if (!token) return null;
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!record) return null;
    if (record.usedAt) return null;
    if (record.expiresAt.getTime() < Date.now()) return null;
    return record;
  }

  /** Only the hash of a reset token is ever stored, never the raw value. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private frontendUrl(): string {
    return (
      process.env.FRONTEND_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000'
    );
  }
}
