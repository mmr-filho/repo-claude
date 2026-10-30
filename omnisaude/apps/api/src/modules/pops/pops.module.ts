import { Module } from '@nestjs/common';
import { PopsController } from './pops.controller';
import { PopsService } from './pops.service';

@Module({ controllers: [PopsController], providers: [PopsService], exports: [PopsService] })
export class PopsModule {}
