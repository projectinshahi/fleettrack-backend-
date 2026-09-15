import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PodService } from './pod.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UpsertPodDto } from './dto/upsert-pod.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * Proof-of-delivery API (POD-01 / POD-03 / POD-04). Mounted under `trips/:id/pod`,
 * mirroring the trip cost API (`trips/:id/cost`) — read for ADMIN + CLIENT, write
 * CLIENT-only, ownership enforced in the service via the JWT `userId`. Proof media is
 * NOT here: it uses the shared /uploads API with category POD_PHOTO / POD_SIGNATURE.
 */
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PodController {
  constructor(private readonly podService: PodService) {}

  @Roles('ADMIN', 'CLIENT')
  @Get(':id/pod')
  getPod(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.podService.getByTrip(req.user, id);
  }

  @Roles('CLIENT')
  @Put(':id/pod')
  upsertPod(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpsertPodDto,
  ) {
    return this.podService.upsert(req.user, id, dto);
  }
}
