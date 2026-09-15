import { TrackingGateway } from './tracking.gateway';

/**
 * Phase 10 security tests — socket authentication + per-client room scoping.
 * JwtService and the socket/server are mocked.
 */
describe('TrackingGateway — socket auth + scoping (Phase 10)', () => {
  function makeSocket(auth: any) {
    return {
      handshake: { auth, headers: {} },
      data: {} as any,
      join: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  it('rejects a socket with no token', () => {
    const jwt: any = { verify: jest.fn() };
    const gw = new TrackingGateway(jwt);
    const sock = makeSocket({});
    gw.handleConnection(sock as any);
    expect(sock.disconnect).toHaveBeenCalled();
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('rejects a socket with an invalid token', () => {
    const jwt: any = {
      verify: jest.fn(() => {
        throw new Error('bad token');
      }),
    };
    const gw = new TrackingGateway(jwt);
    const sock = makeSocket({ token: 'bad' });
    gw.handleConnection(sock as any);
    expect(sock.disconnect).toHaveBeenCalled();
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('CLIENT joins only its own room', () => {
    const jwt: any = {
      verify: jest.fn(() => ({ role: 'CLIENT', userId: 'clientA' })),
    };
    const gw = new TrackingGateway(jwt);
    const sock = makeSocket({ token: 'ok' });
    gw.handleConnection(sock as any);
    expect(sock.join).toHaveBeenCalledWith('client:clientA');
    expect(sock.join).not.toHaveBeenCalledWith('admins');
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('ADMIN joins the admins room', () => {
    const jwt: any = {
      verify: jest.fn(() => ({ role: 'ADMIN', userId: 'a1' })),
    };
    const gw = new TrackingGateway(jwt);
    const sock = makeSocket({ token: 'ok' });
    gw.handleConnection(sock as any);
    expect(sock.join).toHaveBeenCalledWith('admins');
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('emitVehicleUpdate routes an assigned vehicle to its client room + admins', () => {
    const gw = new TrackingGateway({} as any);
    const emit = jest.fn();
    const chain: any = { to: jest.fn(), emit };
    chain.to.mockReturnValue(chain);
    (gw as any).server = { to: chain.to };

    gw.emitVehicleUpdate({ id: 'v1', clientId: 'clientA' });

    expect(chain.to).toHaveBeenCalledWith('client:clientA');
    expect(chain.to).toHaveBeenCalledWith('admins');
    expect(emit).toHaveBeenCalledWith(
      'vehicleLocationUpdate',
      expect.objectContaining({ id: 'v1', clientId: 'clientA' }),
    );
  });

  it('emitVehicleUpdate routes an unassigned vehicle to admins only', () => {
    const gw = new TrackingGateway({} as any);
    const emit = jest.fn();
    const chain: any = { to: jest.fn(), emit };
    chain.to.mockReturnValue(chain);
    (gw as any).server = { to: chain.to };

    gw.emitVehicleUpdate({ id: 'v2', clientId: null });

    expect(chain.to).toHaveBeenCalledWith('admins');
    expect(chain.to).not.toHaveBeenCalledWith('client:null');
    expect(emit).toHaveBeenCalled();
  });
});
