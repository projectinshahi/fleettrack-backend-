import { Module } from '@nestjs/common';
import {
  CustomersController,
  CustomerReportController,
} from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController, CustomerReportController],
  providers: [CustomersService],
})
export class CustomersModule {}
