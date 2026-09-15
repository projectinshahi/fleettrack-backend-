import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { TripRequestsService } from './trip-requests.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateTripDto } from '../trips/dto/create-trip.dto';
import { RejectTripRequestDto } from './dto/reject-trip-request.dto';
import { ApproveTripRequestDto } from './dto/approve-trip-request.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * Trip Request + Admin Approval workflow — Slice 1 (request creation + reads).
 *
 * A CLIENT submits the existing trip payload here instead of POST /trips; it is stored
 * as a PENDING TripRequest and no Trip is created until an ADMIN approves (Slice 2).
 * Only a CLIENT may create; reads are ownership-scoped in the service (CLIENT own, ADMIN
 * all). Reuses the shared JWT + roles guards and the trip module's CreateTripDto, so a
 * request is validated with the identical rules as a direct trip.
 */
@Controller('trip-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripRequestsController {
  constructor(private readonly service: TripRequestsService) {}

  @Roles('CLIENT')
  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateTripDto) {
    return this.service.create(req.user, dto);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get()
  findAll(@Req() req: AuthedRequest) {
    return this.service.findAll(req.user);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get(':id')
  findOne(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.findOne(req.user, id);
  }

  /**
   * ADMIN approves a PENDING request → creates the Trip (reuses TripsService.create).
   * The driver (name + phone) is supplied here, not by the requesting CLIENT.
   */
  @Roles('ADMIN')
  @Patch(':id/approve')
  approve(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ApproveTripRequestDto,
  ) {
    return this.service.approve(req.user, id, dto);
  }

  /**
   * Delete a request. ADMIN may delete any; a CLIENT only its own (enforced in the
   * service). An approved request is deleted together with the Trip it produced, in one
   * transaction — see TripRequestsService.remove.
   */
  @Roles('ADMIN', 'CLIENT')
  @Delete(':id')
  remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.remove(req.user, id);
  }

  /** ADMIN rejects a PENDING request with a mandatory reason → no Trip created. */
  @Roles('ADMIN')
  @Patch(':id/reject')
  reject(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: RejectTripRequestDto,
  ) {
    return this.service.reject(req.user, id, dto.reason);
  }
}
