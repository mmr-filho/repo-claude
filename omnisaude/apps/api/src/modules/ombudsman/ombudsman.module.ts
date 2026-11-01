import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CitizenOmbudsmanController, OmbudsmanController } from './ombudsman.controller';
import { OmbudsmanService } from './ombudsman.service';
import { SatisfactionService } from './satisfaction.service';

@Module({ imports: [IntegrationsModule], controllers: [OmbudsmanController, CitizenOmbudsmanController], providers: [OmbudsmanService, SatisfactionService], exports: [OmbudsmanService, SatisfactionService] })
export class OmbudsmanModule {}
