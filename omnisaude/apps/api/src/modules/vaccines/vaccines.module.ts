import { Module } from '@nestjs/common';
import { VaccinesController } from './vaccines.controller';
import { VaccinesService } from './vaccines.service';

@Module({ controllers: [VaccinesController], providers: [VaccinesService] })
export class VaccinesModule {}
