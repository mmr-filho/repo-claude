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

  emitToUnit(tenantId: string, unitId: string, event: string, payload: unknown) {
    const room = RealtimeService.unitRoom(tenantId, unitId);
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
