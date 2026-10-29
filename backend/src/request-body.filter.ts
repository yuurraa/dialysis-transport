import { Catch, Inject, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';

/** Parser errors occur before controllers; never expose their raw request body. */
@Catch()
export class RequestBodyFilter extends BaseExceptionFilter {
  constructor(@Inject(HttpAdapterHost) private readonly adapter:HttpAdapterHost) {
    super(adapter.httpAdapter);
  }

  override catch(exception:unknown,host:ArgumentsHost) {
    const error=exception as {type?:unknown;status?:unknown;statusCode?:unknown}|null;
    if(error&&typeof error==='object'&&error.type==='entity.parse.failed'
      &&(error.status===400||error.statusCode===400)) {
      const response=host.switchToHttp().getResponse();
      if(!this.adapter.httpAdapter.isHeadersSent(response)) {
        this.adapter.httpAdapter.reply(response,{statusCode:400,error:'Bad Request',message:'Invalid JSON request body.'},400);
      }else this.adapter.httpAdapter.end(response);
      return;
    }
    super.catch(exception,host);
  }
}
