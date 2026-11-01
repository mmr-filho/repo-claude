import { Module } from '@nestjs/common';
import { BedsController } from './beds.controller';
import { BedsService } from './beds.service';
import { VigilanciaModule } from '../vigilancia/vigilancia.module';

@Module({ imports: [VigilanciaModule], controllers: [BedsController], providers: [BedsService], exports: [BedsService] })
export class BedsModule {}
