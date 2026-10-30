import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/** Administração do tenant pela gestão: unidades, profissionais, lotações, segurança. */
@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
