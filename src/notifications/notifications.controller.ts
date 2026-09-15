import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { NotificationQueryDto } from './dto/notification-query.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * In-portal notification API (NOT-04.2 / NOT-04.3). Read + mark-read for the operations
 * roles (ADMIN, CLIENT); the list is audience-scoped in the service (CLIENT sees its own,
 * ADMIN sees only admin-audience notifications — clientId null). Reuses the shared JWT +
 * roles guards. Notifications are raised by domain triggers (Trip / POD / TripRequest),
 * never created here.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'CLIENT')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query() query: NotificationQueryDto) {
    return this.notifications.list(req.user, query);
  }

  // Static route declared before `:id/read` so it is never shadowed by the param route.
  @Patch('read-all')
  markAllRead(@Req() req: AuthedRequest) {
    return this.notifications.markAllRead(req.user);
  }

  @Patch(':id/read')
  markRead(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.notifications.markRead(req.user, id);
  }
}
