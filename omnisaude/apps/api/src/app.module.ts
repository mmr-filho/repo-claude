import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { AccessibilityModule } from './modules/accessibility/accessibility.module';
import { AuthModule } from './modules/auth/auth.module';
import { BedsModule } from './modules/beds/beds.module';
import { BiModule } from './modules/bi/bi.module';
import { BillingModule } from './modules/billing/billing.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { ManagementModule } from './modules/management/management.module';
import { PatientsModule } from './modules/patients/patients.module';
import { PharmacyModule } from './modules/pharmacy/pharmacy.module';
import { PlatformModule } from './modules/platform/platform.module';
import { PopsModule } from './modules/pops/pops.module';
import { ReceptionModule } from './modules/reception/reception.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { SocialModule } from './modules/social/social.module';
import { TriageModule } from './modules/triage/triage.module';

@Module({
  imports: [
    CoreModule,
    AuthModule,
    IntegrationsModule,
    PatientsModule,
    SchedulingModule,
    ReceptionModule,
    TriageModule,
    ClinicalModule,
    PharmacyModule,
    BedsModule,
    PopsModule,
    BillingModule,
    BiModule,
    ManagementModule,
    SocialModule,
    AccessibilityModule,
    PlatformModule,
  ],
})
export class AppModule {}
