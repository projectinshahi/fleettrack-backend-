import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe for the container/reverse proxy (`GET /api/v1/health`).
 *
 * Deliberately PUBLIC: it carries no `@UseGuards`, and this app registers its guards
 * per-controller rather than globally (no APP_GUARD), so omitting them is all that is
 * needed — every other controller stays protected exactly as before.
 *
 * Deliberately does NOT touch the database. This answers "is the Node process alive and
 * serving?", not "is every dependency healthy". A DB round-trip here would turn a brief
 * Neon blip into a failed healthcheck and a container restart loop, taking the API down
 * for a problem it cannot fix by restarting. A readiness probe that checks Prisma is a
 * separate endpoint if we ever need one.
 *
 * It exposes no version, build or environment detail — nothing an unauthenticated caller
 * could use to fingerprint the deployment.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
