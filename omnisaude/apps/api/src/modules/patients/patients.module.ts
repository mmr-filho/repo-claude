import { Module } from '@nestjs/common';
import { PatientDocumentsController } from './documents.controller';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';

@Module({ controllers: [PatientsController, PatientDocumentsController], providers: [PatientsService], exports: [PatientsService] })
export class PatientsModule {}
