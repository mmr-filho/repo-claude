import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createMasterClient, envCredentials, TenantConnectionManager, type MasterClient } from '@omnisaude/database';
import { APP_CONFIG, type AppConfig } from './config';

export const MASTER_DB = Symbol('MASTER_DB');

@Injectable()
export class TenantsService implements OnModuleDestroy {
  readonly connections: TenantConnectionManager;

  constructor(
    @Inject(MASTER_DB) readonly master: MasterClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.connections = new TenantConnectionManager(master, { credentials: envCredentials(), ssl: config.DB_SSL ?? false, poolSize: config.DB_POOL_SIZE });
  }

  resolve(slugOrId: string) {
    return this.connections.resolve(slugOrId);
  }

  client(tenantId: string) {
    return this.connections.client(tenantId);
  }

  readonlyPool(tenantId: string) {
    return this.connections.readonlyPool(tenantId);
  }

  async onModuleDestroy() {
    await this.connections.close();
    await this.master.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: MASTER_DB, useFactory: (config: AppConfig) => createMasterClient(config.MASTER_DATABASE_URL), inject: [APP_CONFIG] },
    TenantsService,
  ],
  exports: [MASTER_DB, TenantsService],
})
export class DatabaseModule {}
