import { Global, Module } from '@nestjs/common';
import { PatientsModule } from '../patients/patients.module';
import { AiService } from './ai.service';
import { DocumentsService } from './documents.service';
import { IntegrationConfigService } from './integration-config.service';
import { IntegrationsController, JobsController, WebhooksController } from './integrations.controller';
import { JobsService } from './jobs.service';
import { MessagingService } from './messaging.service';
import { RndsService } from './rnds.service';

@Global()
@Module({
  imports: [PatientsModule],
  controllers: [IntegrationsController, WebhooksController, JobsController],
  providers: [IntegrationConfigService, AiService, MessagingService, RndsService, DocumentsService, JobsService],
  exports: [IntegrationConfigService, AiService, MessagingService, RndsService, JobsService],
})
export class IntegrationsModule {}
