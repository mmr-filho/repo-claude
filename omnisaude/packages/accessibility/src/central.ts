import { TypedEmitter } from './emitter';
import type { CallContext, CancelReason, EndReason } from './signaling';

/**
 * Central de intérpretes de Libras: fila de chamados, disponibilidade e pareamento profissional-intérprete.
 * Sem dependência de framework: o gateway (NestJS/Socket.IO) traduz eventos em mensagens de sinalização.
 */

export type CallRequestStatus = 'QUEUED' | 'ASSIGNED' | 'CANCELLED' | 'TIMEOUT' | 'ENDED';

export interface CallRequest {
  id: string;
  requesterId: string;
  unitId: string;
  context: CallContext;
  note?: string;
  createdAt: number;
  status: CallRequestStatus;
  roomId?: string;
}

export interface ActiveCall {
  roomId: string;
  requestId: string;
  requesterId: string;
  interpreterId: string;
  startedAt: number;
}

export type InterpreterStatus = 'AVAILABLE' | 'BUSY' | 'OFFLINE';

export interface InterpreterState {
  id: string;
  status: InterpreterStatus;
  /** Desde quando está livre: o intérprete livre há mais tempo recebe o próximo chamado. */
  availableSince?: number;
  roomId?: string;
}

export type CentralEvents = {
  queued: { request: CallRequest; position: number };
  positions: { requestId: string; requesterId: string; position: number }[];
  assigned: { request: CallRequest; call: ActiveCall };
  cancelled: { request: CallRequest; reason: CancelReason };
  timeout: { request: CallRequest };
  ended: { call: ActiveCall; reason: EndReason };
};

export interface InterpreterCentralOptions {
  /** Tempo máximo na fila antes de desistir (padrão 2 min). */
  requestTimeoutMs?: number;
  now?: () => number;
  idGenerator?: () => string;
}

export class CentralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CentralError';
  }
}

export class InterpreterCentral extends TypedEmitter<CentralEvents> {
  private readonly requests = new Map<string, CallRequest>();
  private readonly waiting: string[] = [];
  private readonly calls = new Map<string, ActiveCall>();
  private readonly team = new Map<string, InterpreterState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: InterpreterCentralOptions = {}) {
    super();
    this.timeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.now = opts.now ?? Date.now;
    this.newId = opts.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  requestInterpreter(input: { requesterId: string; unitId: string; context: CallContext; note?: string }): CallRequest {
    // Um chamado aberto por profissional: repetir o clique devolve o mesmo chamado.
    for (const r of this.requests.values()) {
      if (r.requesterId === input.requesterId && (r.status === 'QUEUED' || r.status === 'ASSIGNED')) return r;
    }
    const request: CallRequest = {
      id: this.newId(),
      requesterId: input.requesterId,
      unitId: input.unitId,
      context: input.context,
      ...(input.note ? { note: input.note } : {}),
      createdAt: this.now(),
      status: 'QUEUED',
    };
    this.requests.set(request.id, request);
    this.waiting.push(request.id);
    this.timers.set(
      request.id,
      setTimeout(() => this.expire(request.id), this.timeoutMs),
    );
    this.emit('queued', { request, position: this.waiting.length });
    this.dispatch();
    return request;
  }

  cancel(requestId: string, byUserId?: string): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'QUEUED') return false;
    if (byUserId && request.requesterId !== byUserId) throw new CentralError('Só quem abriu o chamado pode cancelá-lo');
    this.leaveQueue(request, 'CANCELLED');
    this.requests.delete(request.id);
    this.emit('cancelled', { request, reason: 'REQUESTER' });
    this.emitPositions();
    return true;
  }

  setInterpreterStatus(interpreterId: string, status: 'AVAILABLE' | 'OFFLINE'): InterpreterState {
    const current = this.team.get(interpreterId) ?? { id: interpreterId, status: 'OFFLINE' as InterpreterStatus };
    this.team.set(interpreterId, current);
    if (status === 'OFFLINE') {
      if (current.status === 'BUSY' && current.roomId) this.endCall(current.roomId, 'INTERPRETER_OFFLINE');
      current.status = 'OFFLINE';
      delete current.availableSince;
      delete current.roomId;
    } else if (current.status === 'OFFLINE') {
      // Em atendimento continua ocupado até a chamada terminar.
      current.status = 'AVAILABLE';
      current.availableSince = this.now();
      this.dispatch();
    }
    return { ...current };
  }

  endCall(roomId: string, reason: EndReason = 'HANGUP', byUserId?: string): boolean {
    const call = this.calls.get(roomId);
    if (!call) return false;
    if (byUserId && byUserId !== call.requesterId && byUserId !== call.interpreterId) {
      throw new CentralError('Participante não pertence a esta sala');
    }
    this.calls.delete(roomId);
    const request = this.requests.get(call.requestId);
    if (request) request.status = 'ENDED';
    // Chamados encerrados saem da memória; quem precisa do histórico registra pelos eventos.
    this.requests.delete(call.requestId);
    const interpreter = this.team.get(call.interpreterId);
    if (interpreter && interpreter.status === 'BUSY') {
      interpreter.status = reason === 'INTERPRETER_OFFLINE' ? 'OFFLINE' : 'AVAILABLE';
      delete interpreter.roomId;
      if (interpreter.status === 'AVAILABLE') interpreter.availableSince = this.now();
    }
    this.emit('ended', { call, reason });
    this.dispatch();
    return true;
  }

  /** Encerra tudo o que envolve o usuário (desconexão do socket). */
  disconnect(userId: string): void {
    for (const r of [...this.requests.values()]) {
      if (r.requesterId === userId && r.status === 'QUEUED') this.cancel(r.id);
    }
    for (const call of [...this.calls.values()]) {
      if (call.requesterId === userId) this.endCall(call.roomId, 'REQUESTER_LEFT');
    }
    if (this.team.has(userId)) this.setInterpreterStatus(userId, 'OFFLINE');
  }

  canJoinRoom(roomId: string, userId: string): boolean {
    const call = this.calls.get(roomId);
    return !!call && (call.requesterId === userId || call.interpreterId === userId);
  }

  /** O outro participante da sala, para o gateway retransmitir mensagens rtc.*. */
  roomPeer(roomId: string, userId: string): string | null {
    const call = this.calls.get(roomId);
    if (!call) return null;
    if (call.requesterId === userId) return call.interpreterId;
    if (call.interpreterId === userId) return call.requesterId;
    return null;
  }

  /** Chamados abertos (na fila ou em atendimento). */
  getRequest(id: string): CallRequest | undefined {
    return this.requests.get(id);
  }

  queue(): CallRequest[] {
    return this.waiting.map((id) => this.requests.get(id)!);
  }

  activeCalls(): ActiveCall[] {
    return [...this.calls.values()];
  }

  interpreters(): InterpreterState[] {
    return [...this.team.values()].map((i) => ({ ...i }));
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.removeAllListeners();
  }

  private dispatch(): void {
    let assignedAny = false;
    while (this.waiting.length > 0) {
      const free = [...this.team.values()]
        .filter((i) => i.status === 'AVAILABLE')
        .sort((a, b) => (a.availableSince ?? 0) - (b.availableSince ?? 0))[0];
      if (!free) break;
      const request = this.requests.get(this.waiting.shift()!)!;
      this.clearTimer(request.id);
      const call: ActiveCall = {
        roomId: this.newId(),
        requestId: request.id,
        requesterId: request.requesterId,
        interpreterId: free.id,
        startedAt: this.now(),
      };
      request.status = 'ASSIGNED';
      request.roomId = call.roomId;
      free.status = 'BUSY';
      free.roomId = call.roomId;
      delete free.availableSince;
      this.calls.set(call.roomId, call);
      this.emit('assigned', { request, call });
      assignedAny = true;
    }
    if (assignedAny) this.emitPositions();
  }

  private expire(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'QUEUED') return;
    this.leaveQueue(request, 'TIMEOUT');
    this.requests.delete(request.id);
    this.emit('timeout', { request });
    this.emitPositions();
  }

  private leaveQueue(request: CallRequest, status: 'CANCELLED' | 'TIMEOUT'): void {
    request.status = status;
    const idx = this.waiting.indexOf(request.id);
    if (idx >= 0) this.waiting.splice(idx, 1);
    this.clearTimer(request.id);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private emitPositions(): void {
    if (this.waiting.length === 0) return;
    this.emit(
      'positions',
      this.waiting.map((id, i) => ({ requestId: id, requesterId: this.requests.get(id)!.requesterId, position: i + 1 })),
    );
  }
}
