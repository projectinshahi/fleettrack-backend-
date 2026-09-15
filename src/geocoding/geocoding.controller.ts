import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { GeocodingService } from './geocoding.service';
import { GeocodeDto } from './dto/geocode.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

/**
 * Batch address → coordinates for the trip creation modal (route preview +
 * optimization). Trip create/update geocode server-side directly via the service;
 * this endpoint serves the pre-creation, address-only flows on the client.
 */
@Controller('geocode')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GeocodingController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Roles('ADMIN', 'CLIENT')
  @Post()
  async geocode(@Body() dto: GeocodeDto) {
    const points = await this.geocoding.geocodeMany(dto.addresses);
    return { success: true, points };
  }
}
