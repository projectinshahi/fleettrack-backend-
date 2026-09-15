import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { GpsModule } from '../gps/gps.module';
import { TrackingGateway } from './tracking.gateway';
import { TrackingService } from './tracking.service';

@Module({
  // JwtModule so the gateway can verify the socket handshake token with the same secret.
  // GpsModule provides the provider adapters + config the sync polls.
  imports: [
    PrismaModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
    GpsModule,
  ],

  providers: [TrackingGateway, TrackingService],

  exports: [TrackingGateway, TrackingService],
})
export class TrackingModule {}
