import { Module } from '@nestjs/common';
import { OmbudsmanModule } from '../ombudsman/ombudsman.module';
import { ClinicalController } from './clinical.controller';
import { ClinicalService } from './clinical.service';

@Module({
  imports: [OmbudsmanModule],
  controllers: [ClinicalController],
  providers: [ClinicalService],
  exports: [ClinicalService],
})
export class ClinicalModule {}
