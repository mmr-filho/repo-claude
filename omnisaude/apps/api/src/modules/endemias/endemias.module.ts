import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TerritorioModule } from '../territorio/territorio.module';
import { VigilanciaModule } from '../vigilancia/vigilancia.module';
import { BloqueioService } from './bloqueio.service';
import { CampoAceService } from './campo.service';
import { EndemiasController } from './endemias.controller';
import { EstoqueVetorialService } from './estoque-vetorial.service';
import { SupervisaoEndemiasService } from './supervisao.service';

/**
 * Endemias (VIG-3a): o ACE em campo e o bloqueio de transmissão. Importa a vigilância (a notificação abre a ordem por um
 * ouvinte, sem dependência de volta) e o território (quarteirões no raio, escopo do agente).
 */
@Module({
  imports: [IntegrationsModule, TerritorioModule, VigilanciaModule],
  controllers: [EndemiasController],
  providers: [CampoAceService, BloqueioService, SupervisaoEndemiasService, EstoqueVetorialService],
  exports: [BloqueioService],
})
export class EndemiasModule {}
