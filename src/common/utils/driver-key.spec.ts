import { driverIdFromName, driverKey } from './driver-key';

describe('driverKey', () => {
  it('uses the stored driverId when there is one', () => {
    expect(driverKey('drv:ravi-kumar', 'Somebody Else')).toBe('drv:ravi-kumar');
  });

  it('derives the listDrivers id from a typed-in name when driverId is null', () => {
    expect(driverKey(null, '  Ravi   Kumar ')).toBe('drv:ravi-kumar');
  });

  it('returns null when there is neither an id nor a usable name', () => {
    expect(driverKey(null, '   ')).toBeNull();
    expect(driverKey(undefined, null)).toBeNull();
  });

  it('matches the id a picked driver carries', () => {
    expect(driverIdFromName('Ravi Kumar')).toBe('drv:ravi-kumar');
  });
});
