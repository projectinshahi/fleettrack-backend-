import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Driver assignment supplied by the ADMIN when approving a trip request. The CLIENT never
 * sends driver details, so approval is the point at which the trip gets one — both fields
 * are mandatory here, and the service trims and re-checks them so a whitespace-only value
 * cannot slip through the DTO.
 */
export class ApproveTripRequestDto {
  @IsString()
  @IsNotEmpty()
  driverName: string;

  @IsString()
  @IsNotEmpty()
  driverPhone: string;
}
