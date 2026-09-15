import { Module } from '@nestjs/common';
import { TripRequestsController } from './trip-requests.controller';
import { TripRequestsService } from './trip-requests.service';
import { TripsModule } from '../trips/trips.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Trip Request + Admin Approval workflow. Imports TripsModule to reuse TripsService —
 * its ownership checks now (Slice 1) and its create() for approved trips (Slice 2) — so
 * the trip-creation implementation is never duplicated. Imports NotificationsModule to
 * raise the request/approval/rejection notifications through the single NotificationsService.
 */
@Module({
  imports: [TripsModule, NotificationsModule],
  controllers: [TripRequestsController],
  providers: [TripRequestsService],
})
export class TripRequestsModule {}
