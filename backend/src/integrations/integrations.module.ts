import { Module } from '@nestjs/common';
import { OneMapService } from './onemap.service';
import { LtaService } from './lta.service';
import { CalendarService } from './calendar.service';

@Module({ providers: [OneMapService, LtaService, CalendarService], exports: [OneMapService, LtaService, CalendarService] })
export class IntegrationsModule {}
