import { Body, Controller, Get, Header, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ProfilesService } from './profiles.service';

/** UC-02: coordinator-managed operational records, separate from login accounts. */
@Controller('profiles')
export class ProfilesController {
  constructor(@Inject(ProfilesService) private readonly service: ProfilesService) {}

  @Get('caregivers') @Header('Cache-Control','no-store')
  caregivers(@Headers('authorization') header:string|undefined,@Query('page') page?:string,@Query('search') search?:string,@Query('sort') sort?:string,@Query('direction') direction?:string,@Query('status') status?:string){return this.service.listCaregivers(header,page,search,sort,direction,status);}

  @Get('caregivers/:id/links') @Header('Cache-Control','no-store')
  caregiverPatients(@Headers('authorization') header:string|undefined,@Param('id') id:string){return this.service.coordinatorCaregiverLinks(header,id);}

  @Patch('caregivers/:id') @Header('Cache-Control','no-store')
  caregiverStatus(@Headers('authorization') header:string|undefined,@Param('id') id:string,@Body() body:unknown){return this.service.saveCaregiverStatus(header,id,body);}

  @Get('caregiver') @Header('Cache-Control','no-store')
  ownCaregiver(@Headers('authorization') header?:string){return this.service.ownCaregiver(header);}

  @Patch('caregiver') @Header('Cache-Control','no-store')
  saveOwnCaregiver(@Headers('authorization') header:string|undefined,@Body() body:unknown){return this.service.saveOwnCaregiver(header,body);}

  @Get('caregiver-links') @Header('Cache-Control','no-store')
  caregiverLinks(@Headers('authorization') header:string|undefined,@Query('patient') patient?:string){return this.service.listCaregiverLinks(header,patient);}

  @Post('caregiver-invitations') @Header('Cache-Control','no-store')
  createCaregiverInvitation(@Headers('authorization') header?:string){return this.service.createCaregiverInvitation(header);}

  @Post('caregiver-invitations/preview') @Header('Cache-Control','no-store')
  previewCaregiverInvitation(@Headers('authorization') header:string|undefined,@Body() body:unknown){return this.service.reviewCaregiverInvitation(header,body);}

  @Post('caregiver-invitations/confirm') @Header('Cache-Control','no-store')
  confirmCaregiverInvitation(@Headers('authorization') header:string|undefined,@Body() body:unknown){return this.service.reviewCaregiverInvitation(header,body,true);}

  @Patch('caregiver-links') @Header('Cache-Control','no-store')
  manageCaregiverLink(@Headers('authorization') header:string|undefined,@Body() body:unknown){return this.service.manageCaregiverLink(header,body);}

  @Get('driver')
  ownDriver(@Headers('authorization') header?: string) {
    return this.service.ownDriver(header);
  }

  @Patch('driver')
  completeOwnDriver(@Headers('authorization') header: string | undefined, @Body() body: unknown) {
    return this.service.completeOwnDriver(header, body);
  }

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
