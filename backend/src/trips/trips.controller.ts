import { Body, Controller, Delete, Get, Header, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
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

  @Post(':id/recovery-options')
  @Header('Cache-Control','no-store')
  recovery(@Headers('authorization') header:string|undefined,@Param('id') id:string,@Body() body:unknown){
    return this.service.assessRecovery(header,id,body);
  }

  @Post(':id/recovery-approval')
  @Header('Cache-Control','no-store')
  approveRecovery(@Headers('authorization') header:string|undefined,@Param('id') id:string,@Body() body:unknown){
    return this.service.approveRecovery(header,id,body);
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

  @Get('notifications')
  notifications(@Headers('authorization') header: string | undefined, @Query('page') page?: string) {
    return this.service.listNotifications(header, page);
  }

  @Patch('notifications/read-all')
  readAllNotifications(@Headers('authorization') header:string|undefined,@Body() body:unknown) {
    return this.service.readAllNotifications(header,body);
  }

  @Delete('notifications/read')
  @Header('Cache-Control','no-store')
  deleteReadNotifications(@Headers('authorization') header:string|undefined,@Body() body:unknown){
    return this.service.deleteReadNotifications(header,body);
  }

  @Patch('notifications/:id/read')
  readNotification(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.readNotification(header, id, body);
  }

  @Get(':id/route')
  route(@Headers('authorization') header: string | undefined, @Param('id') id: string) {
    return this.service.tripRoute(header, id);
  }

  @Get(':id/traffic')
  @Header('Cache-Control', 'no-store')
  traffic(@Headers('authorization') header: string | undefined, @Param('id') id: string) {
    return this.service.assessRoute(header, id);
  }

  @Get(':id/history')
  history(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Query('page') page?: string) {
    return this.service.getHistory(header, id, page);
  }

  @Get(':id/progress')
  @Header('Cache-Control', 'no-store')
  progress(@Headers('authorization') header: string | undefined, @Param('id') id: string) {
    return this.service.progress(header, id);
  }

  @Patch(':id/start')
  start(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.executeTrip(header, id, body, 'start');
  }

  @Patch(':id/complete')
  complete(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.executeTrip(header, id, body, 'complete');
  }

  @Post(':id/sharing')
  sharing(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.beginSharing(header, id, body);
  }

  @Delete(':id/sharing')
  stopSharing(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.clearLocation(header, id, body);
  }

  @Post(':id/location')
  location(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateLocation(header, id, body);
  }

  @Get(':id')
  details(@Headers('authorization') header: string | undefined, @Param('id') id: string) {
    return this.service.getTrip(header, id);
  }

  @Patch(':id/confirm')
  confirm(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.confirmTrip(header, id, body);
  }

  @Patch(':id/cancel')
  cancel(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.cancelTrip(header, id, body);
  }

  @Patch(':id/unavailable')
  unavailable(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.reportUnavailability(header, id, body);
  }

}
