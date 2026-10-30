import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingJobs } from './billing.jobs';
import { BillingService } from './billing.service';

@Module({ controllers: [BillingController], providers: [BillingService, BillingJobs], exports: [BillingService] })
export class BillingModule {}
