import { IsDateString, IsOptional } from 'class-validator';

/**
 * Optional baseline for ETA-shift alerting (ETA-06.1). When supplied, the alerts
 * endpoint compares the live ETA against this previously-known ETA and raises an
 * ETA_SHIFT alert if the drift is significant. Omitted → only delay alerts apply
 * (no server-side ETA history exists yet to derive a shift from).
 */
export class EtaAlertsQueryDto {
  @IsOptional()
  @IsDateString()
  baselineEtaTimestamp?: string;
}
