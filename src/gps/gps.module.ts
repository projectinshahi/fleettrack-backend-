import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { GpsIntegrationService } from './gps-integration.service';
import { GpsIntegrationController } from './gps-integration.controller';

@Module({
  imports: [PrismaModule],
  controllers: [GpsIntegrationController],
  providers: [GpsIntegrationService],
  exports: [GpsIntegrationService],
})
export class GpsModule {}
