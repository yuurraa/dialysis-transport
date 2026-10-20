import { Body, Controller, Get, Headers, Inject, Param, Patch, Post } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';

/** UC-03, UC-03.1, UC-06 and UC-07: schedules, matching and availability. */
@Controller('schedules')
export class SchedulingController {
  constructor(@Inject(SchedulingService) private readonly service: SchedulingService) {}
  @Get()
  treatments(@Headers('authorization') header?: string) { return this.service.treatments(header); }

  @Post()
  create(@Headers('authorization') header: string | undefined, @Body() body: unknown) { return this.service.saveTreatment(header, body); }

  @Patch(':id')
  update(@Headers('authorization') header: string | undefined, @Body() body: unknown, @Param('id') id: string) { return this.service.saveTreatment(header, body, id); }
}
