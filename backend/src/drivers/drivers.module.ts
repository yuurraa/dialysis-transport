import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriversController } from './drivers.controller';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { DriversService } from './drivers.service';

@Module({ imports: [AuthModule], controllers: [AvailabilityController, DriversController], providers: [DriversService, AvailabilityService] })
export class DriversModule {}
