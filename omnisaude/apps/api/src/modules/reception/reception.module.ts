import { Module } from '@nestjs/common';
import { ReceptionController } from './reception.controller';
import { ReceptionService } from './reception.service';

@Module({ controllers: [ReceptionController], providers: [ReceptionService], exports: [ReceptionService] })
export class ReceptionModule {}
