import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { roleHasPermission, type Permission } from '@omnisaude/shared';
import type { Server, Socket } from 'socket.io';
import { RealtimeService } from './realtime.service';
import { TokenService } from './tokens';

const SALA_ENDEMIAS: Permission[] = ['endemias.ler', 'endemias.supervisionar', 'endemias.campo'];

/**
 * Canal de tempo real (Socket.IO, namespace /rt): painel de chamada de senhas, filas e censo de leitos.
 * O cliente entra na sala da unidade do seu token (sessão de acesso ou token de painel), na do tenant e, se o papel
 * lê, supervisiona ou executa as endemias, na sala das endemias (ordens de bloqueio).
 */
@WebSocketGateway({ namespace: '/rt', cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('TempoReal');

  constructor(
    private readonly realtime: RealtimeService,
    private readonly tokens: TokenService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  async handleConnection(client: Socket) {
    const token = (client.handshake.auth?.token as string | undefined) ?? (client.handshake.query.token as string | undefined);
    const claims = token ? await this.tokens.verify(token) : null;
    if (!claims || (claims.stage !== 'access' && claims.stage !== 'panel') || !claims.unit) {
      client.emit('erro', { message: 'Sessão inválida' });
      client.disconnect(true);
      return;
    }
    await client.join(RealtimeService.unitRoom(claims.tid, claims.unit));
    await client.join(RealtimeService.tenantRoom(claims.tid));
    // Ordens de bloqueio: só quem lê, supervisiona ou executa (o token de painel não tem papel e fica de fora).
    const role = claims.stage === 'access' ? claims.role : undefined;
    if (role && SALA_ENDEMIAS.some((p) => roleHasPermission(role, p))) await client.join(RealtimeService.endemiasRoom(claims.tid));
    client.emit('conectado', { unitId: claims.unit });
    this.logger.debug(`Cliente ${client.id} na unidade ${claims.unit}`);
  }
}
