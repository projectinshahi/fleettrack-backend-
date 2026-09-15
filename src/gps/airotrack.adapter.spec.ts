import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import { AiroTrackAdapter } from './airotrack.adapter';

describe('AiroTrackAdapter.normalizePosition', () => {
  it('maps the confirmed live AiroTrack shape', () => {
    const p = AiroTrackAdapter.normalizePosition({
      vehicleNumber: 'KL01AB1234',
      last_updated: '2026-08-11 10:00:00',
      lat: 10.5,
      long: 76.2,
      speed: 42,
      ignition: true,
      power: 12.4,
      charge: true,
    });

    expect(p).toMatchObject({
      providerName: 'airotrack',
      providerVehicleId: 'KL01AB1234',
      vehicleNumber: 'KL01AB1234',
      imei: null,
      gpsDeviceId: 'KL01AB1234',
      latitude: 10.5,
      longitude: 76.2,
      speed: 42,
      ignition: true,
      batteryVoltage: 12.4,
      charge: true,
    });
    expect(p!.providerTimestamp).toBeInstanceOf(Date);
  });

  it('returns null when vehicleNumber is missing', () => {
    expect(AiroTrackAdapter.normalizePosition({ lat: 1, long: 2 })).toBeNull();
  });

  it('defaults missing coords/speed to 0 and keeps absent battery as null', () => {
    const p = AiroTrackAdapter.normalizePosition({
      vehicleNumber: 'X',
      ignition: false,
    });
    expect(p).toMatchObject({
      latitude: 0,
      longitude: 0,
      speed: 0,
      ignition: false,
      batteryVoltage: null,
      charge: null,
    });
    expect(p!.providerTimestamp).toBeNull();
  });
});

/**
 * A stalled provider must not hold the sync tick. fetch() waits up to 300 s for headers by
 * default and the sync polls providers one after another, so without a per-call timeout one
 * hung AiroTrack request also kept Transight from being polled.
 */
describe('AiroTrackAdapter request timeout', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Accepts the connection and never answers.
    server = createServer(() => undefined);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/positionsByToken`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('gives up after the configured timeout with an error that names the provider', async () => {
    const adapter = new AiroTrackAdapter({
      baseUrl,
      credential: 't',
      timeoutMs: 150,
    });
    const started = Date.now();
    await expect(adapter.getLatestPositions()).rejects.toThrow(
      'AiroTrack request timed out after 150 ms',
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
