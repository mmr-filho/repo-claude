import { TypedEmitter } from './emitter';
import type { IceServerConfig, RtcMessage, SignalingMessage } from './signaling';

/** Canal de sinalização abstrato (Socket.IO, WebSocket puro...): o cliente só precisa enviar e receber. */
export interface SignalingChannel {
  send(message: SignalingMessage): void;
  onMessage(handler: (message: SignalingMessage) => void): () => void;
}

export type CallState = 'idle' | 'starting' | 'connecting' | 'connected' | 'ended' | 'failed';

export interface LibrasCallClientOptions {
  channel: SignalingChannel;
  roomId: string;
  /** Quem cria a oferta. Por convenção, o intérprete (entra na sala depois do profissional). */
  initiator: boolean;
  iceServers?: IceServerConfig[];
  /** Libras é uma língua visual: o padrão pede vídeo em boa resolução e taxa de quadros. */
  media?: MediaStreamConstraints;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

export const DEFAULT_ICE_SERVERS: IceServerConfig[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export const DEFAULT_LIBRAS_MEDIA: MediaStreamConstraints = {
  audio: true,
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, min: 15 }, facingMode: 'user' },
};

type ClientEvents = { state: CallState; remoteStream: MediaStream; error: Error };

/** Cliente WebRTC de navegador para a chamada com o intérprete de Libras. */
export class LibrasCallClient extends TypedEmitter<ClientEvents> {
  private pc: RTCPeerConnection | null = null;
  private local: MediaStream | null = null;
  private unsubscribe: (() => void) | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private chain: Promise<void> = Promise.resolve();
  private current: CallState = 'idle';

  constructor(private readonly opts: LibrasCallClientOptions) {
    super();
  }

  get state(): CallState {
    return this.current;
  }

  get localStream(): MediaStream | null {
    return this.local;
  }

  async start(): Promise<MediaStream> {
    if (this.current !== 'idle') throw new Error('Chamada já iniciada');
    this.setState('starting');
    try {
      const create = this.opts.createPeerConnection ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
      const pc = create({ iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS });
      this.pc = pc;
      // Mensagens recebidas antes da mídia ficar pronta esperam na fila (this.chain).
      let markReady!: () => void;
      const ready = new Promise<void>((r) => (markReady = r));
      this.chain = ready;
      this.unsubscribe = this.opts.channel.onMessage((m) => this.enqueue(m));

      pc.onicecandidate = (e) => {
        const c = e.candidate;
        this.opts.channel.send({
          type: 'rtc.ice',
          roomId: this.opts.roomId,
          candidate: c
            ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment }
            : null,
        });
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (stream) this.emit('remoteStream', stream);
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') this.setState('connected');
        else if (s === 'failed') this.fail(new Error('Falha na conexão de mídia (verifique o servidor TURN)'));
        else if (s === 'closed' && this.current !== 'ended') this.setState('ended');
      };

      const getUserMedia = this.opts.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
      this.local = await getUserMedia(this.opts.media ?? DEFAULT_LIBRAS_MEDIA);
      for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
      this.setState('connecting');
      markReady();

      if (this.opts.initiator) {
        await this.run(async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.opts.channel.send({ type: 'rtc.offer', roomId: this.opts.roomId, sdp: offer.sdp ?? '' });
        });
      }
      return this.local;
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Encerra a chamada; `notify` avisa o servidor (falso quando o encerramento veio dele). */
  hangup(notify = true): void {
    if (this.current === 'ended') return;
    if (notify) this.opts.channel.send({ type: 'call.end', roomId: this.opts.roomId });
    this.cleanup();
    this.setState('ended');
  }

  private enqueue(m: SignalingMessage): void {
    if (!('roomId' in m) || m.roomId !== this.opts.roomId) return;
    if (m.type === 'call.ended') {
      this.hangup(false);
      return;
    }
    if (m.type === 'rtc.offer' || m.type === 'rtc.answer' || m.type === 'rtc.ice') void this.run(() => this.handle(m));
  }

  private run(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task).catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    this.chain = next;
    return next;
  }

  private async handle(m: RtcMessage): Promise<void> {
    const pc = this.pc;
    if (!pc || this.current === 'ended' || this.current === 'failed') return;
    if (m.type === 'rtc.offer') {
      if (this.opts.initiator) return; // oferta cruzada: quem inicia ignora
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await this.flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.opts.channel.send({ type: 'rtc.answer', roomId: this.opts.roomId, sdp: answer.sdp ?? '' });
    } else if (m.type === 'rtc.answer') {
      if (!this.opts.initiator) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      await this.flushIce();
    } else if (m.candidate) {
      const init: RTCIceCandidateInit = {
        candidate: m.candidate.candidate,
        sdpMid: m.candidate.sdpMid ?? null,
        sdpMLineIndex: m.candidate.sdpMLineIndex ?? null,
        ...(m.candidate.usernameFragment ? { usernameFragment: m.candidate.usernameFragment } : {}),
      };
      // Candidatos que chegam antes da descrição remota ficam guardados.
      if (pc.remoteDescription) await pc.addIceCandidate(init);
      else this.pendingIce.push(init);
    }
  }

  private async flushIce(): Promise<void> {
    const pending = this.pendingIce;
    this.pendingIce = [];
    for (const c of pending) await this.pc!.addIceCandidate(c);
  }

  private fail(err: Error): void {
    if (this.current === 'failed' || this.current === 'ended') return;
    this.cleanup();
    this.setState('failed');
    this.emit('error', err);
  }

  private cleanup(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.local?.getTracks() ?? []) t.stop();
    this.pc?.close();
    this.pc = null;
    this.pendingIce = [];
  }

  private setState(s: CallState): void {
    if (s === this.current) return;
    this.current = s;
    this.emit('state', s);
  }
}
