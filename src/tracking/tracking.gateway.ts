import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

/** A live vehicle update payload — the full Vehicle row (shape unchanged for consumers). */
type VehicleUpdate = Record<string, any> & { clientId?: string | null };

// Socket CORS origin. Reuses the existing FRONTEND_URL env var (same one auth uses for
// reset links), so production restricts to the real frontend origin instead of '*';
// local dev falls back to localhost:3000. Set FRONTEND_URL in production.
const SOCKET_CORS_ORIGIN =
  process.env.FRONTEND_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000';

@WebSocketGateway({
  cors: {
    origin: SOCKET_CORS_ORIGIN,
  },
})
export class TrackingGateway
  implements OnGatewayInit, OnGatewayConnection
{
  private readonly logger = new Logger(TrackingGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  afterInit() {
    this.logger.log('Tracking WebSocket Gateway Initialized');
  }

  /**
   * Authenticate every socket on connect with the same JWT used for REST. A socket that
   * doesn't present a valid token is disconnected — no one receives vehicle telemetry
   * without proving identity. Authenticated sockets join a room by principal:
   *   CLIENT -> `client:<clientId>`  (its own vehicles only)
   *   ADMIN  -> `admins`             (centralized fleet)
   * Vehicle updates are then emitted per-room (see emitVehicleUpdate), never globally.
   */
  handleConnection(client: Socket) {
    const token =
      (client.handshake.auth?.token as string | undefined) ||
      (
        client.handshake.headers?.authorization as string | undefined
      )?.replace(/^Bearer\s+/i, '');

    if (!token) {
      client.disconnect();
      return;
    }

    try {
      const payload: any = this.jwt.verify(token, {
        secret: process.env.JWT_SECRET,
      });
      const role = payload.role;
      const userId = payload.userId;

      if (role === 'CLIENT') {
        client.data.user = { userId, role };
        client.join(`client:${userId}`);
      } else if (role === 'ADMIN') {
        // ADMIN sees the centralized fleet (matches their REST access).
        client.data.user = { userId, role };
        client.join('admins');
      } else {
        client.disconnect();
      }
    } catch {
      client.disconnect();
    }
  }

  /**
   * Route a vehicle update to only the sockets allowed to see it: the owning client's room
   * plus the centralized `admins` room. An unassigned vehicle (no clientId) goes to admins
   * only. Replaces the previous global `server.emit(...)` broadcast; payload is unchanged.
   */
  emitVehicleUpdate(vehicle: VehicleUpdate) {
    const payload = { ...vehicle, timestamp: Date.now() };

    if (vehicle.clientId) {
      this.server
        .to(`client:${vehicle.clientId}`)
        .to('admins')
        .emit('vehicleLocationUpdate', payload);
    } else {
      this.server.to('admins').emit('vehicleLocationUpdate', payload);
    }
  }
}
