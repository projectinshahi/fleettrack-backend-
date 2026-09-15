/**
 * Whether THIS process runs the scheduled jobs: the GPS provider sync, the offline sweep and
 * the ETA alert scan (every handler registered with @Cron).
 *
 * Off unless SCHEDULED_JOBS_ENABLED is exactly "true". All three write shared production
 * state (vehicle rows, location history, provider sync stamps, notifications) and the sync
 * spends provider API quota, so exactly ONE process may run them. Before this switch every
 * process that booted the app ran all three, including a developer's `npm run start:dev`
 * pointed at the production database. That was measured as a second writer beside the VPS
 * container: pairs of identical VehicleLocationHistory rows written about a second apart, on
 * exactly the days a local API was running. docker-compose.prod.yml sets the flag for the
 * one production container; nothing else should.
 */
export function scheduledJobsEnabled(): boolean {
  return process.env.SCHEDULED_JOBS_ENABLED === 'true';
}
