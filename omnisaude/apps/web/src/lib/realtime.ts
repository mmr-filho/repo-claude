'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SOCKET } from './api';
import { tokenStore } from './storage';

let socket: Socket | null = null;
let socketToken: string | null = null;

/** Conexão única com o canal de tempo real da unidade (/rt). Aceita token de sessão ou de painel. */
export function realtimeSocket(token?: string | null): Socket | null {
  const t = token ?? tokenStore.get();
  if (!t) return null;
  if (socket && socketToken === t) return socket;
  socket?.disconnect();
  socket = io(`${SOCKET.origin}/rt`, { path: SOCKET.path, auth: { token: t }, transports: ['websocket', 'polling'] });
  socketToken = t;
  return socket;
}

/** Assina um evento (ex.: 'senha.chamada', 'fila.atualizada', 'censo') enquanto o componente estiver montado. */
export function useRealtime<T = unknown>(event: string, handler: (payload: T) => void, token?: string | null) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = realtimeSocket(token);
    if (!s) return;
    const fn = (payload: T) => ref.current(payload);
    s.on(event, fn);
    return () => {
      s.off(event, fn);
    };
  }, [event, token]);
}
