import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response, Request } from 'express';

import { VehiclesService } from './vehicles.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CLIENT')
  @Get()
  findAll(
    @Req() req: Request,
    @Query('clientId') clientId?: string,
    @Query('assignment') assignment?: string,
  ) {
    return this.vehiclesService.findAll(
      (req as any).user,
      clientId,
      assignment,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CLIENT')
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Request) {
    return this.vehiclesService.findOne(id, (req as any).user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CLIENT')
  @Get(':id/history')
  getVehicleHistory(@Param('id') id: string, @Req() req: Request) {
    return this.vehiclesService.getVehicleHistory(id, (req as any).user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CLIENT')
  @Get(':id/report')
  async generateReport(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const pdfBuffer =
      await this.vehiclesService.generateVehicleReport(id, (req as any).user);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=vehicle-report-${id}.pdf`,
    });

    res.send(pdfBuffer);
  }
}
