import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { ClientsModule } from './clients/clients.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { TrackingModule } from './tracking/tracking.module';
import { UsersModule } from './users/users.module';
import { TripsModule } from './trips/trips.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { CustomersModule } from './customers/customers.module';
import { DelaysModule } from './delays/delays.module';
import { TripCostModule } from './trip-cost/trip-cost.module';
import { UploadModule } from './upload/upload.module';
import { PodModule } from './pod/pod.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MailModule } from './mail/mail.module';
import { GpsModule } from './gps/gps.module';
import { TripRequestsModule } from './trip-requests/trip-requests.module';
import { HealthController } from './health.controller';
import { scheduledJobsEnabled } from './common/scheduled-jobs';

@Module({
  // Registered here rather than as its own module: the health check has no service, no
  // providers and no dependencies, so a dedicated module would be an empty wrapper.
  controllers: [HealthController],
  imports: [
    // The @Cron jobs (GPS provider sync, offline sweep, ETA alerts) exist only in the ONE
    // process that opts in; see common/scheduled-jobs.ts. Without ScheduleModule their
    // handlers never start, so no other process can become a second writer.
    ...(scheduledJobsEnabled() ? [ScheduleModule.forRoot()] : []),
    PrismaModule,
    MailModule,
    AuthModule,
    VehiclesModule,
    ClientsModule,
    DashboardModule,
    TrackingModule,
    UsersModule,
    TripsModule,
    GeocodingModule,
    CustomersModule,
    DelaysModule,
    TripCostModule,
    UploadModule,
    PodModule,
    NotificationsModule,
    GpsModule,
    TripRequestsModule,
  ],
})
export class AppModule {}
