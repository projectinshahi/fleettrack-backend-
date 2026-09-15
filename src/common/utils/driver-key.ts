/**
 * Driver identity for reports and the driver list.
 *
 * There is no Driver entity. A trip carries a free-text `driverName`, plus a `driverId` only
 * when the driver was picked from the list, in the form `drv:` + the lower-cased,
 * dash-joined name (see TripsService.listDrivers). Every ADMIN direct create and every
 * request approval types the name in and stores driverId null, so keying reports on
 * driverId alone dropped all of those trips: the driver report came back empty, and delay
 * stats put every typed-in driver into one "Unassigned" bucket. Falling back to the same
 * name-derived id listDrivers issues keeps a picked driver and a typed-in driver of the same
 * name in one row.
 */
export function driverIdFromName(
  name: string | null | undefined,
): string | null {
  const trimmed = name?.trim();
  return trimmed ? `drv:${trimmed.toLowerCase().replace(/\s+/g, '-')}` : null;
}

/** The trip's driverId when set, else the id derived from its driver name, else null. */
export function driverKey(
  driverId: string | null | undefined,
  driverName: string | null | undefined,
): string | null {
  return driverId || driverIdFromName(driverName);
}
