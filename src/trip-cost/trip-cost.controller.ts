import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { TripCostService } from './trip-cost.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UpsertTripCostDto } from './dto/upsert-trip-cost.dto';
import { CostReportQueryDto } from './dto/cost-report-query.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * Trip cost API (TCM-01 / TCM-02). Read for ADMIN + CLIENT; write is CLIENT-only,
 * matching the trips convention (the CLIENT owns trip management, the ADMIN is
 * read-only). Ownership is enforced in the service via the JWT `userId`.
 */
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripCostController {
  constructor(private readonly tripCostService: TripCostService) {}

  @Roles('CLIENT')
  @Get(':id/cost')
  getCost(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.tripCostService.getByTrip(req.user, id);
  }

  @Roles('CLIENT')
  @Put(':id/cost')
  upsertCost(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpsertTripCostDto,
  ) {
    return this.tripCostService.upsert(req.user, id, dto);
  }
}

/**
 * Cost report API (TCM-05). Mounted under `trip-costs` (not `trips/:id`) so the
 * report path never collides with the trip `:id` route. Read for ADMIN + CLIENT,
 * scoped in the service; export reuses the pdfkit pattern from the vehicle report.
 */
@Controller('trip-costs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripCostReportController {
  constructor(private readonly tripCostService: TripCostService) {}

  @Roles('CLIENT')
  @Get('report')
  getReport(@Req() req: AuthedRequest, @Query() query: CostReportQueryDto) {
    return this.tripCostService.getReport(req.user, query);
  }

  @Roles('CLIENT')
  @Get('report/export')
  async exportReport(
    @Req() req: AuthedRequest,
    @Query() query: CostReportQueryDto,
    @Res() res: Response,
  ) {
    const pdf = await this.tripCostService.generateReportPdf(req.user, query);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=trip-cost-report.pdf',
    });
    res.send(pdf);
  }
}
