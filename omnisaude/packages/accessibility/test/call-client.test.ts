import { describe, expect, it } from 'vitest';
import { LibrasCallClient, type SignalingChannel, type SignalingMessage } from '@omnisaude/accessibility';

/** RTCPeerConnection simulado: registra chamadas e permite disparar eventos. */
class FakePeerConnection {
  remoteDescription: { type: string; sdp?: string } | null = null;
  localDescription: { type: string; sdp?: string } | null = null;
  connectionState = 'new';
  added: unknown[] = [];
  candidates: unknown[] = [];
  closed = false;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly name: string) {}
  addTrack(track: unknown) {
    this.added.push(track);
  }
  async createOffer() {
    return { type: 'offer', sdp: `offer-${this.name}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `answer-${this.name}` };
  }
  async setLocalDescription(d: { type: string; sdp?: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp?: string }) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: unknown) {
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
  }
  connect() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
}

function channelPair(): [SignalingChannel, SignalingChannel, SignalingMessage[]] {
  const log: SignalingMessage[] = [];
  const handlers: [((m: SignalingMessage) => void)[], ((m: SignalingMessage) => void)[]] = [[], []];
  const make = (me: 0 | 1): SignalingChannel => ({
    send: (m) => {
      log.push(m);
      // Entrega assíncrona, como um socket real.
      queueMicrotask(() => handlers[me === 0 ? 1 : 0].forEach((h) => h(m)));
    },
    onMessage: (h) => {
      handlers[me].push(h);
      return () => handlers[me].splice(handlers[me].indexOf(h), 1);
    },
  });
  return [make(0), make(1), log];
}

const fakeStream = () => {
  const tracks = [{ kind: 'video', stopped: false, stop() { this.stopped = true; } }];
  return { getTracks: () => tracks } as unknown as MediaStream;
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LibrasCallClient', () => {
  it('negocia oferta/resposta, guarda ICE antecipado e encerra', async () => {
    const [chA, chB, log] = channelPair();
    const pcs: FakePeerConnection[] = [];
    const factory = (name: string) => () => {
      const pc = new FakePeerConnection(name);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    };
    const professional = new LibrasCallClient({ channel: chA, roomId: 'sala1', initiator: false, createPeerConnection: factory('prof'), getUserMedia: async () => fakeStream() });
    const interpreter = new LibrasCallClient({ channel: chB, roomId: 'sala1', initiator: true, createPeerConnection: factory('int'), getUserMedia: async () => fakeStream() });
    const states: string[] = [];
    professional.on('state', (s) => states.push(s));

    await professional.start();
    // Candidato do intérprete chega antes da oferta: precisa esperar a descrição remota.
    chB.send({ type: 'rtc.ice', roomId: 'sala1', candidate: { candidate: 'cand-int', sdpMid: '0', sdpMLineIndex: 0 } });
    await tick();
    expect(pcs[0]!.candidates).toEqual([]);

    await interpreter.start();
    await tick();
    await tick();
    const [profPc, intPc] = pcs;
    expect(profPc!.remoteDescription).toEqual({ type: 'offer', sdp: 'offer-int' });
    expect(profPc!.candidates).toHaveLength(1);
    expect(intPc!.remoteDescription).toEqual({ type: 'answer', sdp: 'answer-prof' });
    expect(log.map((m) => m.type)).toEqual(['rtc.ice', 'rtc.offer', 'rtc.answer']);

    profPc!.connect();
    expect(professional.state).toBe('connected');

    // Mensagens de outra sala são ignoradas.
    chB.send({ type: 'rtc.offer', roomId: 'outra', sdp: 'x' });
    await tick();

    interpreter.hangup();
    expect(intPc!.closed).toBe(true);
    expect(log.at(-1)).toEqual({ type: 'call.end', roomId: 'sala1' });
    expect(states).toEqual(['starting', 'connecting', 'connected']);
  });

  it('falha quando a câmera é negada', async () => {
    const [ch] = channelPair();
    const client = new LibrasCallClient({
      channel: ch,
      roomId: 'r',
      initiator: false,
      createPeerConnection: () => new FakePeerConnection('x') as unknown as RTCPeerConnection,
      getUserMedia: async () => {
        throw new Error('NotAllowedError');
      },
    });
    const errors: Error[] = [];
    client.on('error', (e) => errors.push(e));
    await expect(client.start()).rejects.toThrow('NotAllowedError');
    expect(client.state).toBe('failed');
    expect(errors).toHaveLength(1);
  });
});
