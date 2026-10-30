import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CentralError, InterpreterCentral, parseClientMessage, SignalingError, type CentralEvents } from '@omnisaude/accessibility';

let seq = 0;
const ids = () => `id${++seq}`;

describe('central de intérpretes', () => {
  let central: InterpreterCentral;
  let events: { name: keyof CentralEvents; payload: unknown }[];

  beforeEach(() => {
    vi.useFakeTimers();
    seq = 0;
    central = new InterpreterCentral({ requestTimeoutMs: 60_000, idGenerator: ids });
    events = [];
    for (const name of ['queued', 'positions', 'assigned', 'cancelled', 'timeout', 'ended'] as const) {
      central.on(name, (payload) => events.push({ name, payload }));
    }
  });
  afterEach(() => {
    central.dispose();
    vi.useRealTimers();
  });

  it('enfileira e pareia com o intérprete livre há mais tempo', () => {
    const r1 = central.requestInterpreter({ requesterId: 'enf1', unitId: 'upa', context: 'TRIAGEM' });
    const r2 = central.requestInterpreter({ requesterId: 'med1', unitId: 'ubs', context: 'CONSULTA' });
    expect(central.queue().map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(central.requestInterpreter({ requesterId: 'enf1', unitId: 'upa', context: 'TRIAGEM' })).toBe(r1);

    central.setInterpreterStatus('int-a', 'AVAILABLE');
    vi.advanceTimersByTime(1000);
    central.setInterpreterStatus('int-b', 'AVAILABLE'); // r2 vai para int-b

    const assigned = events.filter((e) => e.name === 'assigned').map((e) => e.payload as CentralEvents['assigned']);
    expect(assigned.map((a) => [a.request.id, a.call.interpreterId])).toEqual([
      [r1.id, 'int-a'],
      [r2.id, 'int-b'],
    ]);
    const room = assigned[0]!.call.roomId;
    expect(central.canJoinRoom(room, 'enf1')).toBe(true);
    expect(central.canJoinRoom(room, 'med1')).toBe(false);
    expect(central.roomPeer(room, 'int-a')).toBe('enf1');
    expect(central.interpreters().find((i) => i.id === 'int-a')?.status).toBe('BUSY');

    central.endCall(room, 'HANGUP', 'enf1');
    expect(central.interpreters().find((i) => i.id === 'int-a')?.status).toBe('AVAILABLE');
    expect(() => central.endCall(assigned[1]!.call.roomId, 'HANGUP', 'intruso')).toThrow(CentralError);
  });

  it('expira chamados não atendidos e atualiza posições', () => {
    const r1 = central.requestInterpreter({ requesterId: 'a', unitId: 'u', context: 'RECEPCAO' });
    vi.advanceTimersByTime(30_000);
    central.requestInterpreter({ requesterId: 'b', unitId: 'u', context: 'RECEPCAO' });
    vi.advanceTimersByTime(30_000);
    expect(events.find((e) => e.name === 'timeout')?.payload).toMatchObject({ request: { id: r1.id, status: 'TIMEOUT' } });
    expect(events.filter((e) => e.name === 'positions').at(-1)?.payload).toEqual([{ requestId: 'id2', requesterId: 'b', position: 1 }]);
    expect(central.getRequest(r1.id)).toBeUndefined();
  });

  it('cancelamento só por quem abriu e desconexões limpam o estado', () => {
    const r = central.requestInterpreter({ requesterId: 'a', unitId: 'u', context: 'FARMACIA' });
    expect(() => central.cancel(r.id, 'b')).toThrow(CentralError);
    expect(central.cancel(r.id, 'a')).toBe(true);
    expect(central.queue()).toEqual([]);

    central.setInterpreterStatus('int', 'AVAILABLE');
    central.requestInterpreter({ requesterId: 'c', unitId: 'u', context: 'CONSULTA' });
    expect(central.activeCalls()).toHaveLength(1);
    central.disconnect('int');
    expect(central.activeCalls()).toHaveLength(0);
    expect(events.find((e) => e.name === 'ended')?.payload).toMatchObject({ reason: 'INTERPRETER_OFFLINE' });
    expect(central.interpreters()[0]?.status).toBe('OFFLINE');
  });
});

describe('mensagens de sinalização', () => {
  it('valida e normaliza mensagens do navegador', () => {
    expect(parseClientMessage({ type: 'call.request', unitId: 'u1', context: 'TRIAGEM', extra: 'x' })).toEqual({
      type: 'call.request',
      unitId: 'u1',
      context: 'TRIAGEM',
    });
    expect(parseClientMessage({ type: 'rtc.ice', roomId: 'r', candidate: null })).toEqual({ type: 'rtc.ice', roomId: 'r', candidate: null });
    expect(parseClientMessage({ type: 'rtc.ice', roomId: 'r', candidate: { candidate: 'c', sdpMLineIndex: 0, sdpMid: '0' } })).toMatchObject({
      candidate: { candidate: 'c', sdpMLineIndex: 0, sdpMid: '0' },
    });
  });

  it('recusa mensagens inválidas', () => {
    expect(() => parseClientMessage({ type: 'call.request', unitId: 'u', context: 'BAR' })).toThrow(SignalingError);
    expect(() => parseClientMessage({ type: 'call.assigned', roomId: 'r' })).toThrow(/desconhecido/);
    expect(() => parseClientMessage({ type: 'rtc.offer', roomId: 'r', sdp: 'x'.repeat(200_000) })).toThrow();
    expect(() => parseClientMessage({ type: 'rtc.ice', roomId: 'r', candidate: { candidate: 'c', sdpMLineIndex: -1 } })).toThrow();
    expect(() => parseClientMessage('oi')).toThrow();
  });
});
