import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';

/** UC-03, UC-03.1, UC-06 and UC-07: schedules, matching and availability. */
@Controller('schedules')
export class SchedulingController {
  constructor(@Inject(SchedulingService) private readonly service: SchedulingService) {}
  @Get()
  treatments(@Headers('authorization') header?: string, @Query('page') page?: string, @Query('search') search?: string,
    @Query('kind') kind?: string, @Query('centre') centre?: string, @Query('sort') sort?: string, @Query('order') order?: string) {
    return this.service.treatments(header,page,search,kind,centre,sort,order);
  }

  @Post()
  create(@Headers('authorization') header: string | undefined, @Body() body: unknown) { return this.service.saveTreatment(header, body); }

  @Delete(':id')
  remove(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) { return this.service.deleteTreatment(header, id, body); }

  @Patch(':id')
  update(@Headers('authorization') header: string | undefined, @Body() body: unknown, @Param('id') id: string) { return this.service.saveTreatment(header, body, id); }
}
