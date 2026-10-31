import { Module } from '@nestjs/common';
import { BedsModule } from '../beds/beds.module';
import { AihController } from './aih.controller';
import { AihService } from './aih.service';
import { BedRegulationController } from './bed-regulation.controller';
import { BedRegulationService } from './bed-regulation.service';

@Module({ imports: [BedsModule], controllers: [BedRegulationController, AihController], providers: [BedRegulationService, AihService], exports: [BedRegulationService, AihService] })
export class BedRegulationModule {}
