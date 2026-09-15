import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/** Express request with the JWT-authenticated user attached by the guard. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

@Controller('dashboard')
export class DashboardController {
  constructor(
    private dashboardService: DashboardService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  async getDashboardStats(
    @Req() req: any,
    @Query('clientId') clientId?: string,
  ) {
    const user = req.user;

    const filterClientId =
      user.role === 'CLIENT'
        ? user.userId
        : clientId;

    return this.dashboardService.getDashboardStats(
      filterClientId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('active-vehicles')
  async getActiveVehicles(
    @Req() req: any,
    @Query('clientId') clientId?: string,
  ) {
    const user = req.user;

    const filterClientId =
      user.role === 'CLIENT'
        ? user.userId
        : clientId;

    return this.dashboardService.getActiveVehicles(
      filterClientId,
    );
  }

  /** Trip summary counts for the dashboard cards (DSH-01.1). */
  @UseGuards(JwtAuthGuard)
  @Get('trip-summary')
  async getTripSummary(
    @Req() req: AuthedRequest,
    @Query('clientId') clientId?: string,
  ) {
    const filterClientId =
      req.user.role === 'CLIENT' ? req.user.userId : clientId;

    return this.dashboardService.getTripSummary(filterClientId);
  }

  /** Delivery performance metrics for the dashboard (DSH-04.1). */
  @UseGuards(JwtAuthGuard)
  @Get('delivery-metrics')
  async getDeliveryMetrics(
    @Req() req: AuthedRequest,
    @Query('clientId') clientId?: string,
  ) {
    const filterClientId =
      req.user.role === 'CLIENT' ? req.user.userId : clientId;

    return this.dashboardService.getDeliveryMetrics(filterClientId);
  }

  /** Trips scheduled to start on each of the last 7 days (DSH-05). */
  @UseGuards(JwtAuthGuard)
  @Get('weekly-activity')
  async getWeeklyActivity(
    @Req() req: AuthedRequest,
    @Query('clientId') clientId?: string,
  ) {
    const filterClientId =
      req.user.role === 'CLIENT' ? req.user.userId : clientId;

    return this.dashboardService.getWeeklyActivity(filterClientId);
  }
}