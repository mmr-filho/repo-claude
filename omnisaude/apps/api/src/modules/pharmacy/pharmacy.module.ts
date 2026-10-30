import { Module } from '@nestjs/common';
import { AdministrationService } from './administration.service';
import { PharmacyClock } from './clock';
import { DispensationService } from './dispensation.service';
import { InventoryService } from './inventory.service';
import { LogisticsService } from './logistics.service';
import { NfeService } from './nfe.service';
import { PharmacyController } from './pharmacy.controller';

@Module({
  controllers: [PharmacyController],
  providers: [PharmacyClock, InventoryService, NfeService, LogisticsService, DispensationService, AdministrationService],
  exports: [InventoryService, LogisticsService, PharmacyClock],
})
export class PharmacyModule {}
