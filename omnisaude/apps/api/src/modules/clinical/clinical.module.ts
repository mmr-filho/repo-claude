import { Module } from '@nestjs/common';
import { OmbudsmanModule } from '../ombudsman/ombudsman.module';
import { VigilanciaModule } from '../vigilancia/vigilancia.module';
import { ClinicalController } from './clinical.controller';
import { ClinicalService } from './clinical.service';

@Module({
  imports: [OmbudsmanModule, VigilanciaModule],
  controllers: [ClinicalController],
  providers: [ClinicalService],
  exports: [ClinicalService],
})
export class ClinicalModule {}
