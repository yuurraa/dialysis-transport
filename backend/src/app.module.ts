import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RequestBodyFilter } from './request-body.filter';
import { SupabaseModule } from './supabase.module';
import { DriversModule } from './drivers/drivers.module';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { TripsModule } from './trips/trips.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { DemoModule } from './demo/demo.module';

@Controller('health')
class HealthController {
  /** Process liveness only; does not claim database or integration readiness. */
  @Get()
  health() { return { status: 'ok' }; }
}

@Module({
  imports: [DriversModule, SupabaseModule, AuthModule, ProfilesModule, SchedulingModule, TripsModule, IntegrationsModule, DemoModule],
  controllers: [HealthController],
  providers: [{provide:APP_FILTER,useClass:RequestBodyFilter}],
})
export class AppModule {}
