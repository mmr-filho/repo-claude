import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { CitizenAuthService } from './citizen-auth.service';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';

@Module({ imports: [SchedulingModule], controllers: [CitizenController], providers: [CitizenAuthService, CitizenService] })
export class CitizenModule {}
