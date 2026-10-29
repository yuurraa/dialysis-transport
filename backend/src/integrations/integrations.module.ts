import { Module } from '@nestjs/common';
import { OneMapService } from './onemap.service';
import { LtaService } from './lta.service';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { AuthModule } from '../auth/auth.module';

@Module({ imports:[AuthModule], controllers:[CalendarController], providers: [OneMapService, LtaService, CalendarService], exports: [OneMapService, LtaService, CalendarService] })
export class IntegrationsModule {}
