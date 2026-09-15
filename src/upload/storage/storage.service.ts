import { Readable } from 'stream';

/** DI token for the active storage backend (bound in UploadModule). */
export const STORAGE_SERVICE = 'STORAGE_SERVICE';

/** Result of persisting bytes: the opaque key + which provider now holds them. */
export interface StoredObject {
  storageKey: string;
  provider: string;
}

/**
 * Provider-agnostic storage contract — the swap seam for the whole app. Consumers
 * depend only on this; the concrete backend (local disk now; S3 / Cloudinary / Azure
 * later) is chosen in UploadModule and injected via STORAGE_SERVICE. The display URL is
 * resolved here (never persisted), so switching providers needs no schema or consumer
 * change. Domain-neutral: it moves bytes and knows nothing about receipts or POD.
 */
export interface StorageService {
  /** Persist bytes and return the opaque key + provider id. */
  save(
    buffer: Buffer,
    meta: { originalName: string; mimeType: string },
  ): Promise<StoredObject>;

  /** Resolve a reference the caller can load the object from (local path / signed URL). */
  getUrl(storageKey: string): string;

  /** A readable stream of the stored bytes (used by the local streaming endpoint). */
  getStream(storageKey: string): Readable;

  /** Remove the stored object (best-effort; missing objects are a no-op). */
  delete(storageKey: string): Promise<void>;
}
