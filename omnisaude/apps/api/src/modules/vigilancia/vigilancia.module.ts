import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TerritorioModule } from '../territorio/territorio.module';
import { CatalogoVigilanciaService } from './catalogo.service';
import { ConciliacaoService } from './conciliacao.service';
import { ConsolidadoService } from './consolidado.service';
import { ContingenciaController } from './contingencia.controller';
import { ContingenciaService } from './contingencia.service';
import { DiagramaController } from './diagrama.controller';
import { DiagramaService } from './diagrama.service';
import { ImportacaoController } from './importacao.controller';
import { ImportacaoService } from './importacao.service';
import { MapaCasosService } from './mapa.service';
import { NegativaController } from './negativa.controller';
import { NegativaService } from './negativa.service';
import { NotificacaoService } from './notificacao.service';
import { PopulacaoService } from './populacao.service';
import { SaidaOficialService } from './saida.service';
import { SurtoController } from './surto.controller';
import { SurtoService } from './surto.service';
import { VigilanciaController } from './vigilancia.controller';

/**
 * Vigilância em saúde: notificação compulsória (VIG-1a), saída para os sistemas oficiais (VIG-1b), mapa de casos
 * (PLT-3) e consolidação, diagrama de controle, contingência, surto e notificação negativa (VIG-1c). As dependências
 * entre os serviços novos e o NotificacaoService (job 'vigilancia', gancho da confirmação) podem formar ciclo: use
 * `forwardRef` ou `ModuleRef` nesses pontos.
 */
@Module({
  imports: [IntegrationsModule, TerritorioModule],
  controllers: [VigilanciaController, ImportacaoController, DiagramaController, ContingenciaController, SurtoController, NegativaController],
  providers: [
    CatalogoVigilanciaService,
    NotificacaoService,
    SaidaOficialService,
    MapaCasosService,
    ImportacaoService,
    ConciliacaoService,
    ConsolidadoService,
    DiagramaService,
    PopulacaoService,
    ContingenciaService,
    SurtoService,
    NegativaService,
  ],
  exports: [
    CatalogoVigilanciaService,
    NotificacaoService,
    SaidaOficialService,
    MapaCasosService,
    ImportacaoService,
    ConciliacaoService,
    ConsolidadoService,
    DiagramaService,
    PopulacaoService,
    ContingenciaService,
    SurtoService,
    NegativaService,
  ],
})
export class VigilanciaModule {}
