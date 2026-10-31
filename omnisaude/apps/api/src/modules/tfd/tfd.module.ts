import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TransportModule } from '../transport/transport.module';
import { TfdController } from './tfd.controller';
import { TfdService } from './tfd.service';

@Module({ imports: [IntegrationsModule, TransportModule], controllers: [TfdController], providers: [TfdService] })
export class TfdModule {}
