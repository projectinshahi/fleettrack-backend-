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

import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { CustomerReportQueryDto } from './dto/customer-report-query.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * Customer directory API (CUS-01 / CUS-02). Tenant-owned data: a CLIENT manages
 * only its own customers (mirrors the trips module — ownership is derived from the
 * JWT `userId`, which is the Client id). The ADMIN does not manage customers.
 */
@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  /** The authenticated client's id (owner of every customer in this request). */
  private clientId(req: Request): string {
    return (req as any).user.userId;
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateCustomerDto) {
    return this.customersService.create(this.clientId(req), dto);
  }

  // The only customer endpoint an ADMIN may reach: list a SELECTED client's customers (for
  // ADMIN direct trip creation). CLIENT stays own-scoped. All other routes keep the
  // class-level CLIENT-only rule. The effective client is resolved server-side in the
  // service (CLIENT: JWT; ADMIN: validated ?clientId) — never trusted from the query alone.
  @Roles('CLIENT', 'ADMIN')
  @Get()
  findAll(@Req() req: AuthedRequest, @Query('clientId') clientId?: string) {
    return this.customersService.findAll(req.user, clientId);
  }

  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    return this.customersService.findOne(this.clientId(req), id);
  }

  // Trip history for a customer (CUS-07.2) — scoped to the client's own trips.
  @Get(':id/trips')
  listTrips(@Req() req: Request, @Param('id') id: string) {
    return this.customersService.listTrips(this.clientId(req), id);
  }

  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(this.clientId(req), id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.customersService.remove(this.clientId(req), id);
  }

  /* Reusable pickup/delivery address book (CUS-05 / CUS-06) */

  @Get(':id/addresses')
  listAddresses(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('kind') kind?: string,
  ) {
    return this.customersService.listAddresses(this.clientId(req), id, kind);
  }

  @Post(':id/addresses')
  addAddress(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: CreateAddressDto,
  ) {
    return this.customersService.addAddress(this.clientId(req), id, dto);
  }

  @Patch(':id/addresses/:addressId')
  updateAddress(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('addressId') addressId: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.customersService.updateAddress(
      this.clientId(req),
      id,
      addressId,
      dto,
    );
  }

  @Delete(':id/addresses/:addressId')
  removeAddress(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('addressId') addressId: string,
  ) {
    return this.customersService.removeAddress(this.clientId(req), id, addressId);
  }
}

/**
 * Customer delivery report API (RPT-06). Mounted under `customer-reports` (its own
 * prefix, like `driver-reports` / `vehicle-reports`). CLIENT-only and scoped to the
 * authenticated client's own trips/customers — customers are tenant-owned, so (unlike
 * the trip/driver/vehicle reports) there is no ADMIN view. Export reuses the shared
 * pdfkit pattern; the query groups existing Trip data by customer — no schema.
 */
@Controller('customer-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class CustomerReportController {
  constructor(private readonly customersService: CustomersService) {}

  @Get('deliveries')
  getDeliveries(
    @Req() req: AuthedRequest,
    @Query() query: CustomerReportQueryDto,
  ) {
    return this.customersService.getCustomerReport(req.user.userId, query);
  }

  @Get('deliveries/export')
  async exportDeliveries(
    @Req() req: AuthedRequest,
    @Query() query: CustomerReportQueryDto,
    @Res() res: Response,
  ) {
    const pdf = await this.customersService.generateCustomerPdf(
      req.user.userId,
      query,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename=customer-delivery-report.pdf',
    });
    res.send(pdf);
  }
}
