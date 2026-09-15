import { Module } from '@nestjs/common';
import {
  TripsController,
  TripReportController,
  DriverReportController,
  VehicleReportController,
} from './trips.controller';
import { TripsService } from './trips.service';
import { GeocodingModule } from '../geocoding/geocoding.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [GeocodingModule, NotificationsModule],
  controllers: [
    TripsController,
    TripReportController,
    DriverReportController,
    VehicleReportController,
  ],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
