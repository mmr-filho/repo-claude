import { Controller, Get, Inject, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { Authenticated, Ctx, type RequestContext } from '../../core/context';
import { iceServers, LibrasGateway } from './libras.gateway';

@Controller('accessibility')
class AccessibilityController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Configuração do front-end: servidores ICE do WebRTC e o widget VLibras. */
  @Authenticated()
  @Get('config')
  config_(@Ctx() ctx: RequestContext) {
    return {
      iceServers: iceServers(this.config),
      librasSignaling: { namespace: '/libras', event: 'msg' },
      vlibras: { enabled: true },
      unitId: ctx.session.unitId,
    };
  }
}

@Module({ controllers: [AccessibilityController], providers: [LibrasGateway] })
export class AccessibilityModule {}
