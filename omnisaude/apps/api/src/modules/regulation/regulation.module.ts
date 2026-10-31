import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { RegulationController } from './regulation.controller';
import { RegulationService } from './regulation.service';

@Module({ imports: [IntegrationsModule, SchedulingModule], controllers: [RegulationController], providers: [RegulationService] })
export class RegulationModule {}
