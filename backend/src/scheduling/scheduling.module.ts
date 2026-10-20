import { AuthModule } from '../auth/auth.module';
import { Module } from '@nestjs/common';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';

@Module({ imports: [AuthModule], controllers: [SchedulingController], providers: [SchedulingService], exports: [SchedulingService] })
export class SchedulingModule {}
