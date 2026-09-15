
import { Module } from '@nestjs/common';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  controllers: [
    VehiclesController,
  ],

  // NOTE: TrackingGateway is deliberately NOT provided here. It is owned by TrackingModule
  // (which supplies its JwtService dependency). VehiclesService never injects it, so the
  // previous standalone provider was a dead duplicate that broke DI once the gateway
  // gained a JwtService constructor dependency in Phase 10.
  providers: [
    VehiclesService,
  ],
})
export class VehiclesModule {}
