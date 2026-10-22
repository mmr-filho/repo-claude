import type { ServerEvent } from '@sigilo/core';

export interface Socketish {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Conn {
  sessionId: string;
  socket: Socketish;
}

/** Conexões WebSocket em memória. Só transporta avisos; o conteúdo das mensagens nunca passa por aqui. */
export class Hub {
  private byUser = new Map<string, Set<Conn>>();

  register(userId: string, sessionId: string, socket: Socketish): () => void {
    const conn: Conn = { sessionId, socket };
    let set = this.byUser.get(userId);
    if (!set) this.byUser.set(userId, (set = new Set()));
    set.add(conn);
    return () => {
      const current = this.byUser.get(userId);
      current?.delete(conn);
      if (current?.size === 0) this.byUser.delete(userId);
    };
  }

  send(userId: string, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const conn of this.byUser.get(userId) ?? []) {
      try {
        conn.socket.send(payload);
      } catch {
        /* conexão já caiu; o close handler limpa */
      }
    }
  }

  sendMany(userIds: Iterable<string>, event: ServerEvent): void {
    for (const id of userIds) this.send(id, event);
  }

  /** Encerra as conexões de um usuário (todas, ou todas menos uma sessão). */
  revokeUser(userId: string, exceptSessionId?: string): void {
    const payload = JSON.stringify({ type: 'session.revoked' } satisfies ServerEvent);
    for (const conn of [...(this.byUser.get(userId) ?? [])]) {
      if (conn.sessionId === exceptSessionId) continue;
      try {
        conn.socket.send(payload);
        conn.socket.close(4001, 'revoked');
      } catch {
        /* ignora */
      }
    }
  }

  revokeSession(userId: string, sessionId: string): void {
    const payload = JSON.stringify({ type: 'session.revoked' } satisfies ServerEvent);
    for (const conn of [...(this.byUser.get(userId) ?? [])]) {
      if (conn.sessionId !== sessionId) continue;
      try {
        conn.socket.send(payload);
        conn.socket.close(4001, 'revoked');
      } catch {
        /* ignora */
      }
    }
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }
}
