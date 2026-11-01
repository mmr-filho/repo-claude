import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CatalogoVigilanciaService } from './catalogo.service';
import { NotificacaoService } from './notificacao.service';
import { VigilanciaController } from './vigilancia.controller';

@Module({ imports: [IntegrationsModule], controllers: [VigilanciaController], providers: [CatalogoVigilanciaService, NotificacaoService], exports: [CatalogoVigilanciaService, NotificacaoService] })
export class VigilanciaModule {}
