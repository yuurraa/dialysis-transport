import { Module } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { TripRoutingService } from './routing/trip-routing.service';
import { TrafficMonitorService } from './traffic/traffic-monitor.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule, IntegrationsModule], controllers: [TripsController], providers: [TripsService, TripRoutingService, TrafficMonitorService], exports: [TripsService] })
export class TripsModule {}
