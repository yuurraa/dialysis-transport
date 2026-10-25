import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { DriversService } from './drivers.service';

/** Vehicle registration only; personal signup stays under profiles. */
@Controller('drivers')
export class DriversController {
  constructor(@Inject(DriversService) private readonly service: DriversService) {}

  @Get('me')
  own(@Headers('authorization') header?: string) { return this.service.own(header); }

  @Get('me/week')
  ownWeek(@Headers('authorization') header: string | undefined, @Query('start') start?: string) { return this.service.week(header, '', start, true); }

  @Post('me/vehicle')
  submit(@Headers('authorization') header: string | undefined, @Body() body: unknown) { return this.service.submit(header, body); }

  @Get()
  list(@Headers('authorization') header?: string, @Query('page') page?: string, @Query('search') search?: string, @Query('status') status?: string, @Query('sort') sort?: string, @Query('direction') direction?: string) {
    return this.service.list(header, page, search, status, sort, direction);
  }

  @Get(':id/week')
  week(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Query('start') start?: string) { return this.service.week(header, id, start); }

  @Get(':id/availability')
  availability(@Headers('authorization') header: string | undefined, @Param('id') id: string) { return this.service.availability(header, id); }

  @Patch(':id')
  updateStatus(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) { return this.service.updateStatus(header, id, body); }

  @Patch(':id/review')
  review(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) { return this.service.review(header, id, body); }
}
