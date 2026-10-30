import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import {
  InterpreterCentral,
  isRtcMessage,
  parseClientMessage,
  SignalingError,
  type IceServerConfig,
  type ServerSignalingMessage,
} from '@omnisaude/accessibility';
import { timingSafeEqual } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { TenantsService } from '../../core/database';
import { TokenService } from '../../core/tokens';

interface Peer {
  /** Identificador global: "<tenantId>:<userId>" para profissionais, "int:<nome>" para intérpretes. */
  id: string;
  kind: 'PROFISSIONAL' | 'INTERPRETE';
  tenantId?: string;
  unitId?: string;
}

export function iceServers(config: AppConfig): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: config.STUN_URL }];
  if (config.TURN_URL) servers.push({ urls: config.TURN_URL, username: config.TURN_USERNAME, credential: config.TURN_CREDENTIAL });
  return servers;
}

/**
 * Teleatendimento em Libras (VRS): o profissional aciona um intérprete da central remota com um clique;
 * a central distribui o chamado e este gateway repassa a sinalização WebRTC entre os dois lados da sala.
 * A mídia (vídeo) vai direto entre os navegadores, ou pelo TURN quando configurado.
 */
@WebSocketGateway({ namespace: '/libras', cors: { origin: true } })
export class LibrasGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('Libras');
  readonly central = new InterpreterCentral({ requestTimeoutMs: 120_000 });

  constructor(
    private readonly tokens: TokenService,
    private readonly tenants: TenantsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const ice = iceServers(config);
    this.central.on('queued', ({ request, position }) => this.send(request.requesterId, { type: 'call.queued', requestId: request.id, position }));
    this.central.on('positions', (list) => list.forEach((p) => this.send(p.requesterId, { type: 'call.queued', requestId: p.requestId, position: p.position })));
    this.central.on('assigned', ({ request, call }) => {
      this.send(request.requesterId, { type: 'call.assigned', requestId: request.id, roomId: call.roomId, interpreterId: call.interpreterId, iceServers: ice });
      this.send(call.interpreterId, {
        type: 'call.incoming',
        requestId: request.id,
        roomId: call.roomId,
        requesterId: request.requesterId,
        unitId: request.unitId,
        context: request.context,
        ...(request.note ? { note: request.note } : {}),
        iceServers: ice,
      });
      void this.persist(request.requesterId, request.unitId, call.roomId, call.interpreterId, 'EM_ANDAMENTO');
    });
    this.central.on('cancelled', ({ request, reason }) => this.send(request.requesterId, { type: 'call.cancelled', requestId: request.id, reason }));
    this.central.on('timeout', ({ request }) => this.send(request.requesterId, { type: 'call.timeout', requestId: request.id }));
    this.central.on('ended', ({ call, reason }) => {
      for (const who of [call.requesterId, call.interpreterId]) this.send(who, { type: 'call.ended', roomId: call.roomId, reason });
      void this.finish(call.requesterId, call.roomId);
    });
  }

  private send(peerId: string, message: ServerSignalingMessage) {
    this.server?.to(`peer:${peerId}`).emit('msg', message);
  }

  private keyMatches(key: string) {
    const expected = this.config.LIBRAS_INTERPRETER_KEY;
    if (!expected || key.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  }

  async handleConnection(client: Socket) {
    const auth = (client.handshake.auth ?? {}) as { token?: string; interpreterKey?: string; name?: string };
    let peer: Peer | null = null;
    if (auth.interpreterKey && auth.name && this.keyMatches(auth.interpreterKey)) {
      peer = { id: `int:${auth.name.slice(0, 60)}`, kind: 'INTERPRETE' };
    } else if (auth.token) {
      const claims = await this.tokens.verify(auth.token);
      if (claims?.stage === 'access') peer = { id: `${claims.tid}:${claims.sub}`, kind: 'PROFISSIONAL', tenantId: claims.tid, unitId: claims.unit };
    }
    if (!peer) {
      client.emit('erro', { message: 'Sessão inválida' });
      client.disconnect(true);
      return;
    }
    client.data.peer = peer;
    await client.join(`peer:${peer.id}`);
    client.emit('conectado', { id: peer.id, kind: peer.kind });
  }

  async handleDisconnect(client: Socket) {
    const peer = client.data.peer as Peer | undefined;
    if (!peer) return;
    const remaining = await this.server.in(`peer:${peer.id}`).fetchSockets();
    if (remaining.length === 0) this.central.disconnect(peer.id);
  }

  @SubscribeMessage('msg')
  handle(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const peer = client.data.peer as Peer | undefined;
    if (!peer) return;
    try {
      const msg = parseClientMessage(body);
      if (isRtcMessage(msg)) {
        if (!this.central.canJoinRoom(msg.roomId, peer.id)) throw new SignalingError('Sala não pertence a este usuário');
        const other = this.central.roomPeer(msg.roomId, peer.id);
        if (other) this.send(other, msg as unknown as ServerSignalingMessage);
        return;
      }
      switch (msg.type) {
        case 'call.request':
          if (peer.kind !== 'PROFISSIONAL') throw new SignalingError('Somente profissionais solicitam intérprete');
          this.central.requestInterpreter({ requesterId: peer.id, unitId: peer.unitId ?? msg.unitId, context: msg.context, note: msg.note });
          break;
        case 'call.cancel':
          this.central.cancel(msg.requestId, peer.id);
          break;
        case 'call.end':
          this.central.endCall(msg.roomId, 'HANGUP', peer.id);
          break;
        case 'interpreter.status':
          if (peer.kind !== 'INTERPRETE') throw new SignalingError('Somente intérpretes informam disponibilidade');
          this.central.setInterpreterStatus(peer.id, msg.status);
          break;
      }
    } catch (err) {
      client.emit('erro', { message: (err as Error).message });
    }
  }

  private async persist(requesterId: string, unitId: string, roomId: string, interpreterId: string, status: string) {
    const [tenantId, userId] = requesterId.split(':');
    if (!tenantId || !userId) return;
    try {
      const db = await this.tenants.client(tenantId);
      await db.librasCall.create({ data: { roomId, requestedBy: userId, unitId, interpreterId, status, answeredAt: new Date() } });
    } catch (err) {
      this.logger.warn(`Não foi possível registrar a chamada ${roomId}: ${(err as Error).message}`);
    }
  }

  private async finish(requesterId: string, roomId: string) {
    const [tenantId] = requesterId.split(':');
    if (!tenantId) return;
    try {
      const db = await this.tenants.client(tenantId);
      await db.librasCall.updateMany({ where: { roomId }, data: { status: 'ENCERRADA', endedAt: new Date() } });
    } catch {
      // Registro é complementar: a chamada já terminou para os participantes.
    }
  }

  onModuleDestroy() {
    this.central.dispose();
  }
}
