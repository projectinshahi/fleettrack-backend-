import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { DelaysService } from './delays.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateDelayDto } from './dto/create-delay.dto';
import { DelayStatsQueryDto } from './dto/delay-stats-query.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * Reported-delay ingest/serve API (DLY-01.1). Same authorization model as trips:
 * ADMIN accesses all delays; a CLIENT only its own trips' delays (enforced in the
 * service via the JWT `userId`).
 */
@Controller('delays')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DelaysController {
  constructor(private readonly delaysService: DelaysService) {}

  @Roles('CLIENT')
  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateDelayDto) {
    return this.delaysService.create(req.user, dto);
  }

  @Roles('CLIENT')
  @Get()
  findAll(@Req() req: AuthedRequest) {
    return this.delaysService.findAll(req.user);
  }

  /** Delay aggregation by category/driver/route/period (DLY-04.1). */
  @Roles('CLIENT')
  @Get('stats')
  getStats(@Req() req: AuthedRequest, @Query() query: DelayStatsQueryDto) {
    return this.delaysService.getStats(req.user, query);
  }

  /** Delay analysis report as a PDF (RPT-04.2) — reuses the getStats aggregation. */
  @Roles('CLIENT')
  @Get('stats/export')
  async exportStats(
    @Req() req: AuthedRequest,
    @Query() query: DelayStatsQueryDto,
    @Res() res: Response,
  ) {
    const pdf = await this.delaysService.generateStatsPdf(req.user, query);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=delay-analysis-report.pdf',
    });
    res.send(pdf);
  }
}

/** Per-trip delay listing (DLY-01.1 — delays retrievable per trip). */
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripDelaysController {
  constructor(private readonly delaysService: DelaysService) {}

  @Roles('CLIENT')
  @Get(':id/delays')
  findByTrip(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.delaysService.findByTrip(req.user, id);
  }
}
