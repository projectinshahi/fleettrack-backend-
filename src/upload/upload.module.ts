import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { STORAGE_SERVICE } from './storage/storage.service';
import { LocalDiskStorageService } from './storage/local-disk-storage.service';

/**
 * Shared upload infrastructure. The active storage backend is selected by
 * STORAGE_PROVIDER and bound to STORAGE_SERVICE here — the single place a future
 * S3 / Cloudinary / Azure implementation is wired in, with no change to UploadService,
 * the controller, the schema, or any consuming module.
 */
@Module({
  controllers: [UploadController],
  providers: [
    UploadService,
    LocalDiskStorageService,
    {
      provide: STORAGE_SERVICE,
      useFactory: (local: LocalDiskStorageService) => {
        const provider = process.env.STORAGE_PROVIDER ?? 'local';
        switch (provider) {
          // case 's3': return new S3StorageService(...);
          // case 'cloudinary': return new CloudinaryStorageService(...);
          case 'local':
          default:
            return local;
        }
      },
      inject: [LocalDiskStorageService],
    },
  ],
})
export class UploadModule {}
