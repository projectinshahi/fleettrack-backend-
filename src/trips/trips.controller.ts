import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { TripsService } from './trips.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { UpdateTripStatusDto } from './dto/update-trip-status.dto';
import { OverlapQueryDto } from './dto/overlap-query.dto';
import { TripsQueryDto } from './dto/trips-query.dto';
import { EtaAlertsQueryDto } from './dto/eta-alerts-query.dto';
import { TripReportQueryDto } from './dto/trip-report-query.dto';
import { DriverReportQueryDto } from './dto/driver-report-query.dto';
import { VehicleReportQueryDto } from './dto/vehicle-report-query.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * Trip Management API.
 *
 * Role rule (inverse of vehicles): the CLIENT owns the trip lifecycle (status changes,
 * stops, costs); the ADMIN reads, and is the only role that may CREATE a trip directly —
 * a CLIENT reaches a trip through the request/approval workflow instead. Ownership
 * (client sees only its own trips) is enforced in the service via the JWT `userId`,
 * which is the Client id for a CLIENT account.
 */
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  // ADMIN only — it creates on behalf of a selected client (dto.clientId, validated in
  // the service; ownership/overlap are enforced against the resolved owner, never the
  // frontend selection). A CLIENT must go through the request workflow
  // (POST /trip-requests → ADMIN approve), which is where the driver is assigned, so
  // creating directly would bypass both the approval and the mandatory driver details.
  // Approval itself calls TripsService.create() in-process, so it is unaffected by this.
  @Roles('ADMIN')
  @Post()
  create(@Req() req: Request, @Body() dto: CreateTripDto) {
    return this.tripsService.create((req as any).user, dto);
  }

  // ADMIN reads fleet-wide (optionally narrowed by ?clientId); CLIENT is pinned to its
  // own trips by findAll, which ignores the query param for a CLIENT. `?status=` is
  // optional — omitted, the list is unfiltered exactly as before.
  @Roles('CLIENT', 'ADMIN')
  @Get()
  findAll(@Req() req: Request, @Query() query: TripsQueryDto) {
    return this.tripsService.findAll(
      (req as any).user,
      query.clientId,
      query.status,
    );
  }

  // Must precede @Get(':id') so the ':id' route doesn't capture "overlap".
  // ADMIN scopes to a selected client (query clientId); CLIENT stays JWT-scoped.
  @Roles('CLIENT', 'ADMIN')
  @Get('overlap')
  checkOverlap(@Req() req: Request, @Query() query: OverlapQueryDto) {
    return this.tripsService.checkOverlap((req as any).user, query);
  }

  // TM-10.1 driver lookup. Must precede @Get(':id') so ':id' can't capture "drivers".
  // ADMIN lists a selected client's drivers (query clientId); CLIENT stays JWT-scoped.
  @Roles('CLIENT', 'ADMIN')
  @Get('drivers')
  listDrivers(@Req() req: AuthedRequest, @Query('clientId') clientId?: string) {
    return this.tripsService.listDrivers(req.user, clientId);
  }

  @Roles('CLIENT')
  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.findOne((req as any).user, id);
  }

  @Roles('CLIENT')
  @Get(':id/timeline')
  timeline(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getTimeline((req as any).user, id);
  }

  // Read-only, and the dashboard ETA panel needs it per trip. Ownership stays with the
  // service: getProgress calls assertReadable, which still rejects a CLIENT reading
  // another client's trip.
  @Roles('CLIENT', 'ADMIN')
  @Get(':id/progress')
  progress(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getProgress((req as any).user, id);
  }

  // Same as :id/progress — read-only, needed by the dashboard ETA panel, ownership
  // still enforced by assertReadable inside getEta.
  @Roles('CLIENT', 'ADMIN')
  @Get(':id/eta')
  eta(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getEta((req as any).user, id);
  }

  @Roles('CLIENT')
  @Get(':id/eta/stops')
  stopEtas(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.tripsService.getStopEtas(req.user, id);
  }

  @Roles('CLIENT')
  @Get(':id/delay')
  delay(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.tripsService.getDelay(req.user, id);
  }

  @Roles('CLIENT')
  @Get(':id/eta/alerts')
  etaAlerts(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query() query: EtaAlertsQueryDto,
  ) {
    return this.tripsService.getEtaAlerts(req.user, id, query);
  }

  @Roles('CLIENT')
  @Get(':id/breadcrumbs')
  breadcrumbs(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getBreadcrumbs((req as any).user, id);
  }

  @Roles('CLIENT')
  @Patch(':id/status')
  updateStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateTripStatusDto,
  ) {
    return this.tripsService.updateStatus((req as any).user, id, dto);
  }

  // TM-06.2: server-side optimise & persist the stop sequence (before start).
  @Roles('CLIENT')
  @Post(':id/optimize-stops')
  optimizeStops(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.tripsService.optimizeStops(req.user, id);
  }

  // TM-02.2: mark a stop reached/completed (in transit; enforces sequence order).
  @Roles('CLIENT')
  @Patch(':id/stops/:stopId/complete')
  completeStop(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('stopId') stopId: string,
  ) {
    return this.tripsService.completeStop(req.user, id, stopId);
  }

  @Roles('CLIENT')
  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateTripDto,
  ) {
    return this.tripsService.update((req as any).user, id, dto);
  }

  @Roles('CLIENT')
  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.remove((req as any).user, id);
  }
}

/**
 * Trip summary report API (RPT-01). Mounted under `trip-reports` (not `trips/:id`)
 * so the report path never collides with the trip `:id` route — mirroring the cost
 * report at `trip-costs`. Read for ADMIN + CLIENT (scoped in the service); export
 * reuses the shared pdfkit pattern.
 */
@Controller('trip-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripReportController {
  constructor(private readonly tripsService: TripsService) {}

  @Roles('CLIENT')
  @Get('summary')
  getSummary(@Req() req: AuthedRequest, @Query() query: TripReportQueryDto) {
    return this.tripsService.getSummaryReport(req.user, query);
  }

  @Roles('CLIENT')
  @Get('summary/export')
  async exportSummary(
    @Req() req: AuthedRequest,
    @Query() query: TripReportQueryDto,
    @Res() res: Response,
  ) {
    const pdf = await this.tripsService.generateSummaryPdf(req.user, query);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=trip-summary-report.pdf',
    });
    res.send(pdf);
  }
}

/**
 * Driver performance report API (RPT-02). Mounted under `driver-reports` (its own
 * prefix, like `trip-reports` / `trip-costs`) so it never collides with the trip
 * `:id` route. Read for ADMIN + CLIENT (scoped in the service); export reuses the
 * shared pdfkit pattern. The query groups existing Trip data by driver — no schema.
 */
@Controller('driver-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DriverReportController {
  constructor(private readonly tripsService: TripsService) {}

  @Roles('CLIENT')
  @Get('performance')
  getPerformance(
    @Req() req: AuthedRequest,
    @Query() query: DriverReportQueryDto,
  ) {
    return this.tripsService.getDriverReport(req.user, query);
  }

  @Roles('CLIENT')
  @Get('performance/export')
  async exportPerformance(
    @Req() req: AuthedRequest,
    @Query() query: DriverReportQueryDto,
    @Res() res: Response,
  ) {
    const pdf = await this.tripsService.generateDriverPdf(req.user, query);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename=driver-performance-report.pdf',
    });
    res.send(pdf);
  }
}

/**
 * Vehicle utilization report API (RPT-03). Mounted under `vehicle-reports` (its own
 * prefix, like `driver-reports` / `trip-reports`) so it never collides with the trip
 * `:id` route. Read for ADMIN + CLIENT (scoped in the service); export reuses the
 * shared pdfkit pattern. The query groups existing Trip data by vehicle — no schema.
 */
@Controller('vehicle-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehicleReportController {
  constructor(private readonly tripsService: TripsService) {}

  @Roles('CLIENT')
  @Get('utilization')
  getUtilization(
    @Req() req: AuthedRequest,
    @Query() query: VehicleReportQueryDto,
  ) {
    return this.tripsService.getVehicleReport(req.user, query);
  }

  @Roles('CLIENT')
  @Get('utilization/export')
  async exportUtilization(
    @Req() req: AuthedRequest,
    @Query() query: VehicleReportQueryDto,
    @Res() res: Response,
  ) {
    const pdf = await this.tripsService.generateVehiclePdf(req.user, query);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename=vehicle-utilization-report.pdf',
    });
    res.send(pdf);
  }
}
