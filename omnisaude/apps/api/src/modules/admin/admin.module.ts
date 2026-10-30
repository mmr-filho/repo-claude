import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CnesController } from './cnes.controller';
import { CnesService } from './cnes.service';

/** Administração do tenant pela gestão: unidades, profissionais, lotações, segurança e importação do CNES. */
@Module({
  controllers: [AdminController, CnesController],
  providers: [AdminService, CnesService],
})
export class AdminModule {}
