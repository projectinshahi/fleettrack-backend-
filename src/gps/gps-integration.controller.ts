import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { GpsProviderName } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GpsIntegrationService } from './gps-integration.service';
import { UpsertIntegrationDto } from './dto/upsert-integration.dto';

/**
 * ADMIN-only GPS provider configuration. Reads return masked config (never the
 * credential); the write endpoint accepts a credential but never echoes it back.
 */
@Controller('gps-integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class GpsIntegrationController {
  constructor(private readonly service: GpsIntegrationService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Put(':provider')
  upsert(@Param('provider') provider: string, @Body() dto: UpsertIntegrationDto) {
    const key = provider.toUpperCase();
    if (key !== 'AIROTRACK' && key !== 'TRANSIGHT') {
      throw new BadRequestException('provider must be AIROTRACK or TRANSIGHT');
    }
    return this.service.upsert(key as GpsProviderName, dto);
  }
}
