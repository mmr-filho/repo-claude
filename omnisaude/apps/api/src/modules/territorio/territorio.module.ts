import { Module } from '@nestjs/common';
import { GeocodificacaoService } from './geocodificacao.service';
import { ImportacaoTerritorioService } from './importacao.service';
import { LocalizadorService } from './localizador.service';
import { TerritorioController } from './territorio.controller';
import { TerritorioService } from './territorio.service';

/** Território único (PLT-3). O localizador é usado também pelo cadastro de domicílios e pela vigilância. */
@Module({
  controllers: [TerritorioController],
  providers: [TerritorioService, ImportacaoTerritorioService, GeocodificacaoService, LocalizadorService],
  exports: [TerritorioService, LocalizadorService],
})
export class TerritorioModule {}
