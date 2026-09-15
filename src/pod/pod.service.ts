import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TripEventAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UpsertPodDto } from './dto/upsert-pod.dto';

type AuthUser = { userId: string; role: string; accountType?: string };

/**
 * Proof-of-delivery record (POD-01 / POD-03 / POD-04). Holds the delivery-confirmation
 * metadata (recipient / notes / delivered-at) as a 1:1 row per trip, mirroring the trip
 * cost module. Authorization matches trips: a CLIENT accesses only its own trips'
 * PODs, an ADMIN reads any (the controller restricts writes to CLIENT).
 *
 * Proof MEDIA is NOT handled here — photos (POD-02/05) and signature (POD-06) go through
 * the shared /uploads API with category POD_PHOTO / POD_SIGNATURE, so this module adds
 * no upload or storage logic.
 */
@Injectable()
export class PodService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
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

  /** Read a trip's POD record (null until anything has been saved). */
  async getByTrip(user: AuthUser, tripId: string) {
    await this.getAccessibleTrip(user, tripId);
    const pod = await this.prisma.proofOfDelivery.findUnique({
      where: { tripId },
    });
    return { success: true, pod };
  }

  /**
   * Upsert the POD record (POD-01 / POD-03). Only provided fields are written. When a
   * delivery is confirmed for the first time (deliveredAt newly set), a trip timeline
   * event is recorded (POD-04) — reusing the existing TripEvent audit log so the POD
   * shows up automatically in the trip timeline (no new event type, no schema change to
   * the trips module).
   */
  async upsert(user: AuthUser, tripId: string, dto: UpsertPodDto) {
    const trip = await this.getAccessibleTrip(user, tripId);

    const existing = await this.prisma.proofOfDelivery.findUnique({
      where: { tripId },
    });

    const deliveredAt =
      dto.deliveredAt !== undefined
        ? new Date(dto.deliveredAt)
        : (existing?.deliveredAt ?? null);

    const pod = await this.prisma.proofOfDelivery.upsert({
      where: { tripId },
      create: {
        tripId,
        recipientName: dto.recipientName ?? null,
        notes: dto.notes ?? null,
        deliveredAt,
        confirmedBy: user.userId,
        confirmedByRole: user.role,
        // POD-04.1 — delivery geolocation (optional; null when the client couldn't capture it).
        deliveredLat: dto.deliveredLat ?? null,
        deliveredLng: dto.deliveredLng ?? null,
        deliveredLocationAccuracy: dto.deliveredLocationAccuracy ?? null,
      },
      update: {
        ...(dto.recipientName !== undefined && {
          recipientName: dto.recipientName,
        }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.deliveredAt !== undefined && { deliveredAt }),
        // POD-04.1 — only overwrite geolocation when the caller actually sends it
        // (partial saves never clear an existing captured location).
        ...(dto.deliveredLat !== undefined && {
          deliveredLat: dto.deliveredLat,
        }),
        ...(dto.deliveredLng !== undefined && {
          deliveredLng: dto.deliveredLng,
        }),
        ...(dto.deliveredLocationAccuracy !== undefined && {
          deliveredLocationAccuracy: dto.deliveredLocationAccuracy,
        }),
      },
    });

    // POD-04: surface the confirmation in the trip timeline the first time it happens.
    const newlyConfirmed = !!deliveredAt && !existing?.deliveredAt;
    if (newlyConfirmed) {
      await this.prisma.tripEvent.create({
        data: {
          tripId,
          action: TripEventAction.UPDATED,
          note: pod.recipientName
            ? `Proof of delivery confirmed — received by ${pod.recipientName}`
            : 'Proof of delivery confirmed',
          actorRole: user.role,
          actorName: null,
        },
      });

      // NOT-04.1: notify that proof of delivery was submitted for this trip. Fires from
      // the POD domain (not the generic UploadModule, which stays domain-agnostic) on the
      // same first-confirmation transition that already writes the timeline event.
      await this.notifications.onPodConfirmed({
        id: trip.id,
        reference: trip.reference,
        clientId: trip.clientId,
        status: trip.status,
      });
    }

    return { success: true, pod };
  }
}
