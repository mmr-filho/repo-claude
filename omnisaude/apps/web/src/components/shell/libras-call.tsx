'use client';

import { CALL_CONTEXTS, LibrasCallClient, type CallContext, type CallState, type IceServerConfig, type ServerSignalingMessage, type SignalingChannel, type SignalingMessage } from '@omnisaude/accessibility';
import { PhoneOff, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage, SOCKET } from '@/lib/api';
import { useSession } from '@/lib/session';
import { tokenStore } from '@/lib/storage';

const CONTEXT_LABEL: Record<CallContext, string> = {
  RECEPCAO: 'Recepção',
  TRIAGEM: 'Classificação de risco',
  CONSULTA: 'Consulta',
  FARMACIA: 'Farmácia',
  INTERNACAO: 'Internação',
  OUTRO: 'Outro',
};

type Phase = 'idle' | 'connecting' | 'queued' | 'in-call' | 'ended';

const STATE_LABEL: Record<CallState, string> = {
  idle: 'preparando',
  starting: 'abrindo câmera',
  connecting: 'conectando ao intérprete',
  connected: 'em chamada',
  ended: 'encerrada',
  failed: 'falhou',
};

/** Teleatendimento em Libras (VRS): aciona um intérprete da central remota em um clique, com vídeo bidirecional. */
export function LibrasCallButton() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [context, setContext] = useState<CallContext>('CONSULTA');
  const [note, setNote] = useState('');
  const [position, setPosition] = useState<number | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [callState, setCallState] = useState<CallState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const socket = useRef<Socket | null>(null);
  const client = useRef<LibrasCallClient | null>(null);
  const ice = useRef<IceServerConfig[] | undefined>(undefined);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);

  useEffect(() => () => teardown(), []);

  if (!session.can('libras.acionar')) return null;

  function teardown() {
    client.current?.hangup(false);
    client.current = null;
    socket.current?.disconnect();
    socket.current = null;
  }

  function channel(s: Socket): SignalingChannel {
    return {
      send: (m: SignalingMessage) => void s.emit('msg', m),
      onMessage: (handler) => {
        const fn = (m: SignalingMessage) => handler(m);
        s.on('msg', fn);
        return () => void s.off('msg', fn);
      },
    };
  }

  async function startCall(roomId: string, iceServers: IceServerConfig[] | undefined) {
    const s = socket.current;
    if (!s) return;
    const c = new LibrasCallClient({ channel: channel(s), roomId, initiator: false, iceServers: iceServers ?? ice.current });
    client.current = c;
    c.on('state', (st) => {
      setCallState(st);
      if (st === 'ended' || st === 'failed') setPhase('ended');
    });
    c.on('remoteStream', (stream) => {
      if (remoteVideo.current) {
        remoteVideo.current.srcObject = stream;
        void remoteVideo.current.play().catch(() => {});
      }
    });
    c.on('error', (err) => setMessage(err.message));
    setPhase('in-call');
    try {
      const local = await c.start();
      if (localVideo.current) {
        localVideo.current.srcObject = local;
        void localVideo.current.play().catch(() => {});
      }
    } catch (err) {
      setMessage(`Não foi possível abrir câmera e microfone: ${(err as Error).message}`);
    }
  }

  async function request() {
    setMessage(null);
    setPhase('connecting');
    try {
      const cfg = await api.get<{ iceServers: IceServerConfig[]; unitId: string }>('/accessibility/config');
      ice.current = cfg.iceServers;
      const s = io(`${SOCKET.origin}/libras`, { path: SOCKET.path, auth: { token: tokenStore.get() }, transports: ['websocket', 'polling'] });
      socket.current = s;
      s.on('erro', (e: { message: string }) => setMessage(e.message));
      s.on('connect_error', () => {
        setMessage('Não foi possível conectar à central de intérpretes.');
        setPhase('idle');
      });
      s.on('msg', (m: ServerSignalingMessage) => {
        if (m.type === 'call.queued') {
          setRequestId(m.requestId);
          setPosition(m.position);
          setPhase('queued');
        } else if (m.type === 'call.assigned') {
          setPosition(null);
          void startCall(m.roomId, m.iceServers);
        } else if (m.type === 'call.timeout') {
          setMessage('Nenhum intérprete disponível no momento. Tente novamente em instantes.');
          setPhase('ended');
        } else if (m.type === 'call.cancelled') {
          setPhase('ended');
        } else if (m.type === 'call.ended') {
          setMessage('Chamada encerrada.');
          setPhase('ended');
        }
      });
      s.once('conectado', () => s.emit('msg', { type: 'call.request', unitId: cfg.unitId, context, ...(note.trim() ? { note: note.trim() } : {}) }));
    } catch (err) {
      setMessage(errorMessage(err));
      setPhase('idle');
    }
  }

  function hangup() {
    if (client.current) client.current.hangup(true);
    else if (requestId && socket.current) socket.current.emit('msg', { type: 'call.cancel', requestId });
    setTimeout(teardown, 300);
    setPhase('ended');
  }

  function close(o: boolean) {
    if (!o) {
      if (phase === 'queued' || phase === 'in-call') hangup();
      setPhase('idle');
      setRequestId(null);
      setCallState(null);
      setMessage(null);
    }
    setOpen(o);
  }

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Intérprete de Libras" aria-label="Chamar intérprete de Libras">
        <Video className="h-5 w-5" />
      </Button>
      <Dialog open={open} onOpenChange={close} title="Intérprete de Libras" description="Videochamada com a central de intérpretes para o atendimento de pessoas surdas." size="lg">
        <div className="flex flex-col gap-4">
          {(phase === 'idle' || phase === 'connecting' || phase === 'ended') && (
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
              <Field label="Momento do atendimento" htmlFor="libras-ctx">
                <Select id="libras-ctx" value={context} onChange={(e) => setContext(e.target.value as CallContext)}>
                  {CALL_CONTEXTS.map((c) => (
                    <option key={c} value={c}>
                      {CONTEXT_LABEL[c]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Observação para o intérprete (opcional)" htmlFor="libras-note">
                <Input id="libras-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Button size="lg" onClick={request} loading={phase === 'connecting'}>
                <Video className="h-4 w-4" /> Chamar intérprete
              </Button>
            </div>
          )}
          {phase === 'queued' && (
            <Alert tone="info" title="Aguardando intérprete">
              Posição na fila: <b>{position ?? '—'}</b>. Mantenha esta janela aberta.
            </Alert>
          )}
          {message && <Alert tone="warn">{message}</Alert>}
          {(phase === 'in-call' || phase === 'queued') && (
            <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
              <div className="relative aspect-video overflow-hidden rounded-lg bg-slate-900">
                <video ref={remoteVideo} className="h-full w-full object-contain" playsInline autoPlay aria-label="Vídeo do intérprete" />
                {callState && callState !== 'connected' && <span className="absolute inset-0 flex items-center justify-center text-sm text-white/80">{STATE_LABEL[callState]}…</span>}
              </div>
              <div className="aspect-video overflow-hidden rounded-lg bg-slate-800">
                <video ref={localVideo} className="h-full w-full -scale-x-100 object-cover" playsInline autoPlay muted aria-label="Seu vídeo" />
              </div>
            </div>
          )}
          {callState && <Badge tone={callState === 'connected' ? 'green' : 'slate'}>Chamada: {STATE_LABEL[callState]}</Badge>}
          {(phase === 'queued' || phase === 'in-call') && (
            <Button variant="danger" onClick={hangup} className="self-end">
              <PhoneOff className="h-4 w-4" /> {phase === 'queued' ? 'Cancelar pedido' : 'Encerrar chamada'}
            </Button>
          )}
        </div>
      </Dialog>
    </>
  );
}
