import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { TrackingModule } from '../tracking/tracking.module';

/**
 * In-portal notifications (NOT-01…04). Reuses the shared Socket.IO server by importing
 * TrackingModule (which exports TrackingGateway) — no second gateway. Exports
 * NotificationsService so the Trip and POD modules can fire triggers (Slice 2).
 */
@Module({
  imports: [TrackingModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
