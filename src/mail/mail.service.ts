import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import Handlebars from 'handlebars';
import {
  APP_NAME,
  RESET_PASSWORD_SUBJECT,
  RESET_PASSWORD_TEMPLATE,
  TEMPLATES_DIR,
} from './mail.constants';
import { MailPayload, SendPasswordResetParams } from './mail.types';

/**
 * Owns all outgoing email. Reads SMTP settings from `process.env` (same convention as the
 * rest of the project), builds a Nodemailer transporter once at startup, renders Handlebars
 * templates, and sends. Reusable for future OTP / welcome / invitation / notification emails
 * by adding one thin method per email type on top of the private `send()`.
 *
 * Fail-safe by design: if SMTP is not configured, or a send fails, it LOGS (including the
 * reset URL as a fallback, outside production only) and never throws — so callers such as
 * forgot-password can always return a generic success and never reveal whether an email
 * exists.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter<SMTPTransport.SentMessageInfo> | null = null;
  private from = '';
  private readonly templateCache = new Map<
    string,
    ReturnType<typeof Handlebars.compile>
  >();

  onModuleInit(): void {
    this.from =
      process.env.SMTP_FROM ?? `${APP_NAME} <no-reply@fleettrack.app>`;
    this.transporter = this.createTransporter();

    if (!this.transporter) {
      this.logger.warn(
        'SMTP is not configured (SMTP_HOST missing) — password reset emails cannot be sent (links are logged outside production only).',
      );
      return;
    }

    // Verify the transporter at startup so SMTP/auth problems surface immediately.
    void this.verifyTransporter(this.transporter);
  }

  private createTransporter(): Transporter<SMTPTransport.SentMessageInfo> | null {
    const host = process.env.SMTP_HOST;
    if (!host) return null;

    const port = Number(process.env.SMTP_PORT ?? 587);
    const user = process.env.SMTP_USER;
    // Gmail shows app passwords as four space-separated groups; the spaces are not part
    // of the secret, so strip whitespace to avoid authentication failures.
    const pass = process.env.SMTP_PASS?.replace(/\s+/g, '');

    return createTransport({
      host,
      port,
      secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS (Gmail)
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  private async verifyTransporter(
    transporter: Transporter<SMTPTransport.SentMessageInfo>,
  ): Promise<void> {
    try {
      await transporter.verify();
      this.logger.log('SMTP transporter verified — email delivery is active.');
    } catch (err) {
      this.logger.error(
        `SMTP transporter verification failed: ${this.errorMessage(err)}`,
      );
    }
  }

  /**
   * Send the password-reset email. Never throws: on any failure it logs the error (and the
   * reset URL as a fallback) so the caller can still return a generic success.
   */
  async sendPasswordResetEmail(params: SendPasswordResetParams): Promise<void> {
    const expiry = this.formatExpiry(params.expiresInMinutes);

    const html = this.render(RESET_PASSWORD_TEMPLATE, {
      appName: APP_NAME,
      resetUrl: params.resetUrl,
      expiry,
    });

    await this.send(
      {
        to: params.to,
        subject: RESET_PASSWORD_SUBJECT,
        html,
        text: `Reset your ${APP_NAME} password: ${params.resetUrl}\nThis link expires in ${expiry}. If you didn't request this, you can ignore this email.`,
      },
      params.resetUrl,
    );
  }

  /**
   * A reset link is a bearer credential for the account until it expires, and container logs
   * are kept and readable by anyone with access to the host, so production logs never carry
   * one. Local development still logs it, which is how a reset is tested without SMTP.
   */
  private loggableLink(url: string): string {
    return process.env.NODE_ENV === 'production'
      ? '[withheld in production]'
      : url;
  }

  /** Core sender. Falls back to logging when SMTP is unavailable or a send fails. */
  private async send(
    payload: MailPayload,
    fallbackUrl?: string,
  ): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(
        `No mail provider configured — email to ${payload.to} not sent.${
          fallbackUrl ? ` Reset link: ${this.loggableLink(fallbackUrl)}` : ''
        }`,
      );
      return;
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      });
      this.logger.log(
        `Email sent to ${payload.to} — messageId=${info.messageId}, response=${info.response}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to send email to ${payload.to}: ${this.errorMessage(err)}`,
      );
      if (fallbackUrl) {
        this.logger.warn(
          `Fallback — reset link for ${payload.to}: ${this.loggableLink(fallbackUrl)}`,
        );
      }
      // Deliberately swallowed: never surface delivery failures to the caller.
    }
  }

  private render(name: string, context: Record<string, unknown>): string {
    let template = this.templateCache.get(name);
    if (!template) {
      const source = readFileSync(this.resolveTemplatePath(name), 'utf8');
      template = Handlebars.compile(source);
      this.templateCache.set(name, template);
    }
    return template(context);
  }

  /** Locate a template across the possible dev/build layouts (first match wins). */
  private resolveTemplatePath(name: string): string {
    const candidates = [
      join(__dirname, TEMPLATES_DIR, name),
      join(process.cwd(), 'dist', 'src', 'mail', TEMPLATES_DIR, name),
      join(process.cwd(), 'dist', 'mail', TEMPLATES_DIR, name),
      join(process.cwd(), 'src', 'mail', TEMPLATES_DIR, name),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
      throw new Error(`Email template not found: ${name}`);
    }
    return found;
  }

  private formatExpiry(minutes: number): string {
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
