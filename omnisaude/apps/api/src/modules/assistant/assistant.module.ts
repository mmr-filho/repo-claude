import { Module } from '@nestjs/common';
import { CitizenModule } from '../citizen/citizen.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OmbudsmanModule } from '../ombudsman/ombudsman.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';

@Module({ imports: [IntegrationsModule, SchedulingModule, CitizenModule, OmbudsmanModule], controllers: [AssistantController], providers: [AssistantService], exports: [AssistantService] })
export class AssistantModule {}
