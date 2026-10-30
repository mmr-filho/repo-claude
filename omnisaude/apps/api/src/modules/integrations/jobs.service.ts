import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { MasterClient } from '@omnisaude/database';
import { Queue, Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { MASTER_DB, TenantsService } from '../../core/database';
import { MessagingService, type SystemContext } from './messaging.service';
import { RndsService } from './rnds.service';

type JobName = 'whatsapp' | 'rnds' | 'sigtap';
type TenantJob = (sys: SystemContext) => Promise<unknown>;

/**
 * Jobs em segundo plano (Redis + BullMQ): disparo de WhatsApp, outbox da RNDS e sincronização mensal
 * da SIGTAP. O banco é a fonte da verdade (mensagens agendadas e outbox); os jobs só varrem o que venceu,
 * então reiniciar ou repetir um job não duplica envios. Sem REDIS_URL, um temporizador local faz o mesmo.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly extra = new Map<JobName, TenantJob>();
  private queue?: Queue;
  private worker?: Worker;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MASTER_DB) private readonly master: MasterClient,
    private readonly tenants: TenantsService,
    private readonly messaging: MessagingService,
    private readonly rnds: RndsService,
  ) {}

  /** Outros módulos registram tarefas por tenant (ex.: o faturamento registra a sincronização da SIGTAP). */
  register(name: JobName, job: TenantJob) {
    this.extra.set(name, job);
  }

  async runForAllTenants(name: JobName): Promise<Record<string, unknown>> {
    const tenants = await this.master.tenant.findMany({ where: { status: 'ATIVO' } });
    const out: Record<string, unknown> = {};
    for (const t of tenants) {
      try {
        const tenant = await this.tenants.resolve(t.id);
        const sys: SystemContext = { tenant, db: await this.tenants.client(t.id) };
        out[t.slug] = await this.run(name, sys);
      } catch (err) {
        out[t.slug] = { error: (err as Error).message };
        this.logger.error(`${name}/${t.slug}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  run(name: JobName, sys: SystemContext) {
    if (name === 'whatsapp') return this.messaging.dispatchDue(sys);
    if (name === 'rnds') return this.rnds.dispatchDue(sys);
    const job = this.extra.get(name);
    return job ? job(sys) : Promise.resolve(null);
  }

  async onApplicationBootstrap() {
    if (!this.config.RUN_JOBS) return;
    if (this.config.REDIS_URL) {
      const connection = { url: this.config.REDIS_URL };
      this.queue = new Queue('omnisaude', { connection });
      await this.queue.upsertJobScheduler('whatsapp', { every: 30_000 }, { name: 'whatsapp' });
      await this.queue.upsertJobScheduler('rnds', { every: 60_000 }, { name: 'rnds' });
      // Diariamente às 6h nos primeiros dias do mês; o job verifica se é o primeiro dia útil da competência.
      await this.queue.upsertJobScheduler('sigtap', { pattern: '0 6 1-7 * *', tz: 'America/Sao_Paulo' }, { name: 'sigtap' });
      this.worker = new Worker('omnisaude', (job) => this.runForAllTenants(job.name as JobName), { connection, concurrency: 1 });
      this.logger.log('Jobs ativos com BullMQ');
    } else {
      this.timers.push(setInterval(() => void this.runForAllTenants('whatsapp'), 30_000));
      this.timers.push(setInterval(() => void this.runForAllTenants('rnds'), 60_000));
      this.timers.push(setInterval(() => void this.runForAllTenants('sigtap'), 6 * 3_600_000));
      this.logger.warn('REDIS_URL ausente: jobs rodando com temporizador local (use só em desenvolvimento)');
    }
  }

  async onModuleDestroy() {
    this.timers.forEach(clearInterval);
    await this.worker?.close();
    await this.queue?.close();
  }
}
