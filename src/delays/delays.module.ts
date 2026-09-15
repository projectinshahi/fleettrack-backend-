import { Module } from '@nestjs/common';
import { DelaysController, TripDelaysController } from './delays.controller';
import { DelaysService } from './delays.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NOT-02.1: a reported delay raises a notification. Acyclic:
  // DelaysModule → NotificationsModule → TrackingModule → PrismaModule.
  imports: [NotificationsModule],
  controllers: [DelaysController, TripDelaysController],
  providers: [DelaysService],
})
export class DelaysModule {}
