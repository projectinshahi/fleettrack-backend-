import { Module } from '@nestjs/common';
import { PodController } from './pod.controller';
import { PodService } from './pod.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Proof of delivery (POD). Owns only the delivery-confirmation record; proof media
 * reuses the shared UploadModule, so this module has no upload/storage dependency.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [PodController],
  providers: [PodService],
})
export class PodModule {}
