import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Publica eventos em tempo real (painel de senhas, filas, censo de leitos) para as salas de cada unidade.
 * O gateway registra o servidor Socket.IO aqui; sem gateway (testes, worker) os eventos são descartados.
 */
@Injectable()
export class RealtimeService {
  private server?: Server;
  private readonly logger = new Logger('TempoReal');
  /** Últimos eventos (útil em testes e para depuração). */
  readonly recent: { room: string; event: string; payload: unknown }[] = [];

  attach(server: Server) {
    this.server = server;
  }

  static unitRoom(tenantId: string, unitId: string) {
    return `t:${tenantId}:u:${unitId}`;
  }

  static tenantRoom(tenantId: string) {
    return `t:${tenantId}`;
  }

  /** Sala das endemias: só sessões de quem lê, supervisiona ou trabalha em campo nas endemias (nunca painel de TV). */
  static endemiasRoom(tenantId: string) {
    return `t:${tenantId}:endemias`;
  }

  /** Evento para todas as unidades do tenant (central de regulação, mapa de leitos). */
  emitToTenant(tenantId: string, event: string, payload: unknown) {
    this.emitRoom(RealtimeService.tenantRoom(tenantId), event, payload);
  }

  /**
   * Evento das ordens de bloqueio: a sala do tenant inclui a recepção e os painéis, e o aviso logo depois do da
   * notificação diria que o caso é de arbovirose.
   */
  emitToEndemias(tenantId: string, event: string, payload: unknown) {
    this.emitRoom(RealtimeService.endemiasRoom(tenantId), event, payload);
  }

  emitToUnit(tenantId: string, unitId: string, event: string, payload: unknown) {
    this.emitRoom(RealtimeService.unitRoom(tenantId, unitId), event, payload);
  }

  private emitRoom(room: string, event: string, payload: unknown) {
    this.recent.push({ room, event, payload });
    if (this.recent.length > 200) this.recent.shift();
    if (!this.server) return;
    try {
      this.server.to(room).emit(event, payload);
    } catch (err) {
      this.logger.warn(`Falha ao emitir ${event}: ${(err as Error).message}`);
    }
  }
}
