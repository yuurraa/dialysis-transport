import { Module } from '@nestjs/common';
import { ProfilesController } from './profiles.controller';
import { AuthModule } from '../auth/auth.module';
import { ProfilesService } from './profiles.service';

@Module({ imports: [AuthModule], controllers: [ProfilesController], providers: [ProfilesService], exports: [ProfilesService] })
export class ProfilesModule {}
