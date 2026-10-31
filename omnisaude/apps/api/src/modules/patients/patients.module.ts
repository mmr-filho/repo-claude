import { Module } from '@nestjs/common';
import { PatientDocumentsController } from './documents.controller';
import { HouseholdsController } from './households.controller';
import { HouseholdsService } from './households.service';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';

@Module({ controllers: [PatientsController, PatientDocumentsController, HouseholdsController], providers: [PatientsService, HouseholdsService], exports: [PatientsService, HouseholdsService] })
export class PatientsModule {}
