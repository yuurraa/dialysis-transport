import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { TripsService } from './trips.service';

/** UC-04, UC-05, UC-05.1 and UC-09 to UC-12: operations, recovery and patient actions. */
@Controller('trips')
export class TripsController {
  constructor(@Inject(TripsService) private readonly service: TripsService) {}
  @Get()
  list(@Headers('authorization') header?: string, @Query('page') page?: string, @Query('from') from?: string, @Query('until') until?: string, @Query('status') status?: string, @Query('search') search?: string, @Query('direction') direction?: string, @Query('sort') sort?: string, @Query('order') order?: string) {
    return this.service.listTrips(header, page, from, until, status, search, direction, sort, order);
  }

  @Post('generate')
  generate(@Headers('authorization') header: string | undefined, @Body() body: unknown) {
    return this.service.generateTrips(header, body);
  }

  @Delete(':id')
  remove(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.deleteTrip(header, id, body);
  }
  @Get(':id/assignment-options')
  assignmentOptions(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Query('pickup_at') pickupAt?: string) {
    return this.service.assignmentOptions(header, id, pickupAt);
  }

  @Post(':id/assignment')
  assign(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.assignTrip(header, id, body);
  }

  @Patch(':id/unassign')
  unassign(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.unassignTrip(header, id, body);
  }

}
