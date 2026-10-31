import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { EsusController } from './esus.controller';
import { EsusService } from './esus.service';

@Module({ imports: [IntegrationsModule], controllers: [EsusController], providers: [EsusService], exports: [EsusService] })
export class EsusModule {}
