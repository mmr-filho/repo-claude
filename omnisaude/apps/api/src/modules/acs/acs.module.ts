import { Module } from '@nestjs/common';
import { PatientsModule } from '../patients/patients.module';
import { AcsController } from './acs.controller';
import { AcsService } from './acs.service';

@Module({ imports: [PatientsModule], controllers: [AcsController], providers: [AcsService] })
export class AcsModule {}
