import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { scheduledJobsEnabled } from './common/scheduled-jobs';

// Browser origins allowed to call this API. Resolved exactly like the socket gateway's
// CORS origin and the password-reset link base (same FRONTEND_URL, same trailing-slash
// strip), so HTTP and WebSocket never disagree about which origin is legitimate; local
// dev falls back to localhost:3000. Set FRONTEND_URL in production.
//
// This replaced `origin: true`, which reflected whatever Origin the caller sent straight
// back in Access-Control-Allow-Origin — combined with credentials:true that let ANY site
// on the internet issue credentialed cross-origin calls to this API. An array (not a
// wildcard, never `true`) so an extra origin such as a www host is a one-line addition.
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000',
];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // No framework fingerprint on every response.
  app.disable('x-powered-by');

  app.enableCors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 5000);

  // State the scheduled-jobs decision in the first log lines, so a production container that
  // is missing the flag (and therefore not syncing GPS) is obvious at a glance.
  const logger = new Logger('Bootstrap');
  if (scheduledJobsEnabled()) {
    logger.log(
      'Scheduled jobs ENABLED in this process: GPS provider sync, offline sweep, ETA alert scan',
    );
  } else {
    logger.warn(
      'Scheduled jobs DISABLED in this process (SCHEDULED_JOBS_ENABLED is not "true"): no GPS provider sync, offline sweep or ETA alert scan runs here',
    );
  }
}
bootstrap();