import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TerritorioModule } from '../territorio/territorio.module';
import { CatalogoVigilanciaService } from './catalogo.service';
import { MapaCasosService } from './mapa.service';
import { NotificacaoService } from './notificacao.service';
import { SaidaOficialService } from './saida.service';
import { VigilanciaController } from './vigilancia.controller';

@Module({
  imports: [IntegrationsModule, TerritorioModule],
  controllers: [VigilanciaController],
  providers: [CatalogoVigilanciaService, NotificacaoService, SaidaOficialService, MapaCasosService],
  exports: [CatalogoVigilanciaService, NotificacaoService, SaidaOficialService],
})
export class VigilanciaModule {}
