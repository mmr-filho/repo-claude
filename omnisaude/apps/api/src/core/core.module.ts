import { Controller, Get, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditService } from './audit.service';
import { AuthGuard } from './auth.guard';
import { APP_CONFIG, loadConfig } from './config';
import { DatabaseModule } from './database';
import { AllExceptionsFilter } from './errors';
import { Public } from './context';
import { OutboxService } from './outbox.service';
import { RealtimeService } from './realtime.service';
import { TokenService } from './tokens';

@Controller('health')
class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok', service: 'omnisaude-api', time: new Date().toISOString() };
  }
}

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    TokenService,
    AuditService,
    OutboxService,
    RealtimeService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [APP_CONFIG, TokenService, AuditService, OutboxService, RealtimeService, DatabaseModule],
})
export class CoreModule {}
