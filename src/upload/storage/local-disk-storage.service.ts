import { Injectable } from '@nestjs/common';
import { createReadStream, existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { extname, join } from 'path';
import { Readable } from 'stream';
import { StorageService, StoredObject } from './storage.service';

/**
 * Local-disk storage (first StorageService implementation). Writes each object under
 * UPLOAD_DIR with an unguessable random filename, and serves it back through the
 * authenticated /uploads/file endpoint (UPLOAD_PUBLIC_PATH). Provider-agnostic contract:
 * a future S3/Cloudinary/Azure service implements the same interface and is swapped in
 * UploadModule with no consumer or schema change.
 */
@Injectable()
export class LocalDiskStorageService implements StorageService {
  private readonly dir =
    process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
  private readonly publicPath =
    process.env.UPLOAD_PUBLIC_PATH ?? '/uploads/file';
  private readonly provider = 'local';

  async save(
    buffer: Buffer,
    meta: { originalName: string; mimeType: string },
  ): Promise<StoredObject> {
    await mkdir(this.dir, { recursive: true });
    // Random, unguessable key; keep the original extension (bounded) for content type.
    const ext = extname(meta.originalName).toLowerCase().slice(0, 10);
    const storageKey = `${randomBytes(16).toString('hex')}${ext}`;
    await writeFile(join(this.dir, storageKey), buffer);
    return { storageKey, provider: this.provider };
  }

  getUrl(storageKey: string): string {
    return `${this.publicPath}/${storageKey}`;
  }

  getStream(storageKey: string): Readable {
    return createReadStream(join(this.dir, this.safeKey(storageKey)));
  }

  async delete(storageKey: string): Promise<void> {
    const path = join(this.dir, this.safeKey(storageKey));
    if (existsSync(path)) await unlink(path);
  }

  /** Defence-in-depth against path traversal (keys we generate are hex + extension). */
  private safeKey(storageKey: string): string {
    return storageKey.replace(/[^a-zA-Z0-9._-]/g, '');
  }
}
