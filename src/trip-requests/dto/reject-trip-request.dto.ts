import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Admin rejection of a trip request. A reason is mandatory (NOT-08). Presence is
 * enforced here at the HTTP boundary; the service additionally trims and rejects a
 * whitespace-only reason so a blank reason is impossible regardless of the caller.
 */
export class RejectTripRequestDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}
