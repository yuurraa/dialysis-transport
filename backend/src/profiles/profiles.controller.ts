import { Body, Controller, Get, Headers, Inject, Param, Patch, Query } from '@nestjs/common';
import { ProfilesService } from './profiles.service';

/** UC-02: coordinator-managed operational records, separate from login accounts. */
@Controller('profiles')
export class ProfilesController {
  constructor(@Inject(ProfilesService) private readonly service: ProfilesService) {}

  @Get('patient')
  ownPatient(@Headers('authorization') header?: string) {
    return this.service.ownPatient(header);
  }

  @Patch('patient')
  saveOwnPatient(@Headers('authorization') header: string | undefined, @Body() body: unknown) {
    return this.service.saveOwnPatient(header, body);
  }

  @Get('patients')
  listPatients(@Headers('authorization') header?: string, @Query('page') page?: string,
    @Query('search') search?: string, @Query('sort') sort?: string, @Query('direction') direction?: string, @Query('status') status?: string, @Query('mobility') mobility?: string) {
    return this.service.listPatients(header, page, search, sort, direction, status, mobility);
  }

  @Patch('patients/:id')
  updatePatient(@Headers('authorization') header: string | undefined, @Param('id') id: string, @Body() body: unknown) {
    return this.service.savePatient(header, body, id);
  }
}
