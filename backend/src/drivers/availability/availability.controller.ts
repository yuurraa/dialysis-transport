import { Body, Controller, Get, Headers, Inject, Patch } from '@nestjs/common';
import { AvailabilityService } from './availability.service';

@Controller('drivers/me/availability')
export class AvailabilityController {
  constructor(@Inject(AvailabilityService) private readonly service: AvailabilityService) {}

  @Get()
  get(@Headers('authorization') header?: string) { return this.service.get(header); }

  @Patch()
  save(@Headers('authorization') header: string | undefined, @Body() body: unknown) { return this.service.save(header, body); }
}
