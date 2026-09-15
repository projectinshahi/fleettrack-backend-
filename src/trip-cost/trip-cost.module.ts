import { Module } from '@nestjs/common';
import {
  TripCostController,
  TripCostReportController,
} from './trip-cost.controller';
import { TripCostService } from './trip-cost.service';

@Module({
  controllers: [TripCostController, TripCostReportController],
  providers: [TripCostService],
})
export class TripCostModule {}
