import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { competencia } from '@omnisaude/shared';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { JobsService } from '../integrations/jobs.service';
import { BillingService } from './billing.service';
import { isFirstBusinessDay } from './calendar';

/**
 * Sincronização mensal da tabela SIGTAP no primeiro dia útil da competência. O job roda todo dia nos
 * primeiros dias do mês e só baixa o pacote quando é o dia certo e a competência ainda não foi carregada.
 */
@Injectable()
export class BillingJobs implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly billing: BillingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.jobs.register('sigtap', async (sys) => {
      const now = new Date();
      if (!this.config.SIGTAP_ZIP_URL || !isFirstBusinessDay(now, sys.tenant.timeZone)) return { skipped: true };
      const comp = competencia(now, sys.tenant.timeZone);
      const done = await sys.db.sigtapSync.findFirst({ where: { competencia: comp, status: 'CONCLUIDA', source: { not: 'AMOSTRA_DEMONSTRACAO' } } });
      if (done) return { skipped: true, competencia: comp };
      return this.billing.syncCompetencia(sys.tenant.id, comp);
    });
  }
}
