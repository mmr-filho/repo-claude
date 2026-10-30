import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Processo de jobs em segundo plano (WhatsApp, outbox RNDS, SIGTAP). Usa o mesmo módulo da API sem
 * abrir a porta HTTP; em produção rode réplicas da API e um (ou mais) workers com REDIS_URL.
 */
async function main() {
  process.env.RUN_JOBS = 'true';
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker de jobs iniciado');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
