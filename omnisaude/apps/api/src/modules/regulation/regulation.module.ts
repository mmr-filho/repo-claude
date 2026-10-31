import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RegulationController } from './regulation.controller';
import { RegulationService } from './regulation.service';

@Module({ imports: [IntegrationsModule], controllers: [RegulationController], providers: [RegulationService] })
export class RegulationModule {}
