import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Global mail module (mirrors the @Global PrismaModule) so MailService can be injected
 * anywhere — password reset today, OTP / welcome / invitations / notifications later —
 * without re-importing this module in every feature module.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
