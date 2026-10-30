import { Body, ConflictException, Controller, Delete, Get, Header, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { CalendarService } from './calendar.service';

@Controller('calendar')
export class CalendarController {
  constructor(@Inject(CalendarService) private readonly calendar:CalendarService) {}

  @Get()
  @Header('Cache-Control','no-store')
  status(@Headers('authorization') header?:string) { return this.calendar.status(header); }

  @Post('authorize')
  @Header('Cache-Control','no-store')
  authorize(@Headers('authorization') header?:string) { return this.calendar.authorize(header); }

  @Post('confirm')
  @Header('Cache-Control','no-store')
  confirm(@Headers('authorization') header:string|undefined,@Body() body:unknown) { return this.calendar.confirm(header,body); }

  @Delete()
  disconnect(@Headers('authorization') header?:string) { return this.calendar.disconnect(header); }

  @Get('trips/:id')
  @Header('Cache-Control','no-store')
  reminder(@Headers('authorization') header:string|undefined,@Param('id') id:string) { return this.calendar.reminder(header,id); }

  @Post('trips/:id')
  save(@Headers('authorization') header:string|undefined,@Param('id') id:string,@Body() body:unknown) { return this.calendar.setReminder(header,id,body); }

  @Get('callback')
  @Header('Cache-Control','no-store')
  async callback(@Query() query:{state?:string;code?:string;error?:string},@Res() response:{redirect:(status:number,url:string)=>void;setHeader:(name:string,value:string)=>void}) {
    let result='failed',ticket:string|undefined;
    try { const pending=await this.calendar.callback(query);if(pending){result='confirm';ticket=pending;}else result='cancelled'; }
    catch(error) { if(error instanceof ConflictException&&(error.getResponse() as {code?:string}).code==='calendar_account_mismatch')result='account_mismatch'; }
    const url=new URL('/dashboard/account',process.env.FRONTEND_ORIGIN??'http://localhost:5173');
    url.searchParams.set('calendar',result);if(ticket)url.searchParams.set('ticket',ticket);
    response.setHeader('Referrer-Policy','no-referrer');response.redirect(303,url.toString());
  }
}
