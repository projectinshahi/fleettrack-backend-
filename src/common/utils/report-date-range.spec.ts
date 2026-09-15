import { reportRangeEnd, reportRangeStart } from './report-date-range';

describe('report date range', () => {
  it('reads a calendar-day "from" as the start of that day in IST', () => {
    expect(reportRangeStart('2026-09-15').toISOString()).toBe(
      '2026-09-14T18:30:00.000Z',
    );
  });

  it('reads a calendar-day "to" as the END of that day in IST, not its UTC midnight', () => {
    expect(reportRangeEnd('2026-09-15').toISOString()).toBe(
      '2026-09-15T18:29:59.999Z',
    );
  });

  it('keeps a single-day range non-empty: a trip at 09:00 IST falls inside it', () => {
    const trip = new Date('2026-09-15T03:30:00.000Z'); // 09:00 IST
    expect(trip >= reportRangeStart('2026-09-15')).toBe(true);
    expect(trip <= reportRangeEnd('2026-09-15')).toBe(true);
  });

  it('honours a full ISO timestamp exactly', () => {
    expect(reportRangeStart('2026-09-15T10:00:00.000Z').toISOString()).toBe(
      '2026-09-15T10:00:00.000Z',
    );
    expect(reportRangeEnd('2026-09-15T10:00:00.000Z').toISOString()).toBe(
      '2026-09-15T10:00:00.000Z',
    );
  });
});
