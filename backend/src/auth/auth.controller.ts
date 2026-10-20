import { Body, Controller, Get, Headers, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('me')
  me(@Headers('authorization') header?: string) {
    return this.auth.verifyIdentity(this.token(header));
  }

  @Post('register')
  register(@Headers('authorization') header: string | undefined, @Body() body: unknown) {
    return this.auth.register(this.token(header), body);
  }

  private token(header?: string) {
    const match = header?.match(/^Bearer (\S+)$/i);
    if (!match) throw new UnauthorizedException('Sign-in required.');
    return match[1];
  }
}
