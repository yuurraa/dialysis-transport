import { Module } from '@nestjs/common';
import { OneMapService } from './onemap/onemap.service';
import { LtaService } from './lta/lta.service';
import { CalendarService } from './calendar/calendar.service';
import { CalendarController } from './calendar/calendar.controller';
import { AuthModule } from '../auth/auth.module';

@Module({ imports:[AuthModule], controllers:[CalendarController], providers: [OneMapService, LtaService, CalendarService], exports: [OneMapService, LtaService, CalendarService] })
export class IntegrationsModule {}
