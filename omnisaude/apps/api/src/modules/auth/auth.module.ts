import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DirectoryController } from './directory.controller';

@Global()
@Module({ controllers: [AuthController, DirectoryController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
