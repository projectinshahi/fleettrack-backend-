import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CostComponent, FileAsset, FileCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from './storage/storage.service';

type AuthUser = { userId: string; role: string; accountType?: string };

/** A file received from multer (typed locally so no @types/multer dependency is needed). */
export interface UploadedFileInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

/**
 * File persistence + access control for the whole app (TCM-03, POD, …). Strictly
 * domain-agnostic: it stores/loads/deletes files by generic `category` + owning `tripId`
 * and enforces trip-based ownership (CLIENT owns, ADMIN reads) — it contains no
 * receipt- or POD-specific logic. The owning module decides which category to pass and
 * how to present the files. Bytes go through the injected StorageService (swap seam).
 */
@Injectable()
export class UploadService {
  constructor(
    private prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private storage: StorageService,
  ) {}

  /** A trip the caller may access (CLIENT owns it, ADMIN any); throws otherwise. */
  private async getAccessibleTrip(user: AuthUser, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (user.role === 'CLIENT' && trip.clientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
    return trip;
  }

  async store(
    user: AuthUser,
    params: {
      tripId: string;
      category: FileCategory;
      costComponent?: CostComponent;
      file: UploadedFileInput;
    },
  ) {
    await this.getAccessibleTrip(user, params.tripId);

    const saved = await this.storage.save(params.file.buffer, {
      originalName: params.file.originalName,
      mimeType: params.file.mimeType,
    });

    const asset = await this.prisma.fileAsset.create({
      data: {
        storageKey: saved.storageKey,
        provider: saved.provider,
        category: params.category,
        // TCM-03.2 — only meaningful for RECEIPT; null otherwise (POD / general receipt).
        costComponent: params.costComponent ?? null,
        originalName: params.file.originalName,
        mimeType: params.file.mimeType,
        size: params.file.size,
        tripId: params.tripId,
        uploadedBy: user.userId,
        uploadedByRole: user.role,
      },
    });

    return { success: true, file: this.toDto(asset) };
  }

  async list(
    user: AuthUser,
    tripId: string,
    category?: FileCategory,
    costComponent?: CostComponent,
  ) {
    await this.getAccessibleTrip(user, tripId);

    const files = await this.prisma.fileAsset.findMany({
      where: {
        tripId,
        ...(category ? { category } : {}),
        ...(costComponent ? { costComponent } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, files: files.map((f) => this.toDto(f)) };
  }

  async remove(user: AuthUser, id: string) {
    const asset = await this.prisma.fileAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('File not found');

    // Enforces CLIENT ownership of the owning trip (ADMIN is blocked at the controller).
    await this.getAccessibleTrip(user, asset.tripId);

    await this.storage.delete(asset.storageKey);
    await this.prisma.fileAsset.delete({ where: { id } });

    return { success: true };
  }

  /** Resolve a file for streaming after checking the caller may read its owning trip. */
  async getReadableFile(user: AuthUser, storageKey: string) {
    const asset = await this.prisma.fileAsset.findUnique({
      where: { storageKey },
    });
    if (!asset) throw new NotFoundException('File not found');

    await this.getAccessibleTrip(user, asset.tripId);

    return {
      stream: this.storage.getStream(asset.storageKey),
      mimeType: asset.mimeType,
      originalName: asset.originalName,
    };
  }

  /** Prisma row → API shape (resolves the display URL via the active provider). */
  private toDto(file: FileAsset) {
    return {
      id: file.id,
      category: file.category,
      costComponent: file.costComponent, // TCM-03.2 (null for POD / general receipts)
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      tripId: file.tripId,
      url: this.storage.getUrl(file.storageKey),
      createdAt: file.createdAt,
    };
  }
}
