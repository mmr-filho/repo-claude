import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { RealtimeService } from './realtime.service';
import { TokenService } from './tokens';

/**
 * Canal de tempo real (Socket.IO, namespace /rt): painel de chamada de senhas, filas e censo de leitos.
 * O cliente entra na sala da unidade do seu token (sessão de acesso ou token de painel).
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
    client.emit('conectado', { unitId: claims.unit });
    this.logger.debug(`Cliente ${client.id} na unidade ${claims.unit}`);
  }
}
