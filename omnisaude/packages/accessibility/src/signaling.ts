/**
 * Mensagens de sinalização do Teleatendimento em Libras (VRS). O mesmo formato vale para o gateway
 * (servidor) e para o navegador. A identidade de quem envia vem da sessão autenticada no servidor,
 * nunca do corpo da mensagem.
 */

export const CALL_CONTEXTS = ['RECEPCAO', 'TRIAGEM', 'CONSULTA', 'FARMACIA', 'INTERNACAO', 'OUTRO'] as const;
export type CallContext = (typeof CALL_CONTEXTS)[number];

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** Enviadas pelo navegador ao servidor. */
export type ClientSignalingMessage =
  | { type: 'call.request'; unitId: string; context: CallContext; note?: string }
  | { type: 'call.cancel'; requestId: string }
  | { type: 'call.end'; roomId: string }
  | { type: 'interpreter.status'; status: 'AVAILABLE' | 'OFFLINE' }
  | RtcMessage;

export type RtcMessage =
  | { type: 'rtc.offer'; roomId: string; sdp: string }
  | { type: 'rtc.answer'; roomId: string; sdp: string }
  | { type: 'rtc.ice'; roomId: string; candidate: IceCandidatePayload | null };

/** Enviadas pelo servidor ao navegador. */
export type ServerSignalingMessage =
  | { type: 'call.queued'; requestId: string; position: number }
  | { type: 'call.assigned'; requestId: string; roomId: string; interpreterId: string; iceServers?: IceServerConfig[] }
  | {
      type: 'call.incoming';
      requestId: string;
      roomId: string;
      requesterId: string;
      unitId: string;
      context: CallContext;
      note?: string;
      iceServers?: IceServerConfig[];
    }
  | { type: 'call.cancelled'; requestId: string; reason: CancelReason }
  | { type: 'call.timeout'; requestId: string }
  | { type: 'call.ended'; roomId: string; reason: EndReason }
  | RtcMessage;

export type SignalingMessage = ClientSignalingMessage | ServerSignalingMessage;

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type CancelReason = 'REQUESTER' | 'SHUTDOWN';
export type EndReason = 'HANGUP' | 'INTERPRETER_OFFLINE' | 'REQUESTER_LEFT' | 'SHUTDOWN';

export class SignalingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalingError';
  }
}

const MAX_ID = 128;
const MAX_SDP = 100_000;
const MAX_NOTE = 500;

function str(obj: Record<string, unknown>, key: string, max = MAX_ID): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new SignalingError(`Campo "${key}" inválido`);
  return v;
}

function optStr(obj: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new SignalingError(`Campo "${key}" inválido`);
  return v;
}

function candidate(v: unknown): IceCandidatePayload | null {
  // null sinaliza fim da coleta de candidatos.
  if (v === null) return null;
  if (!v || typeof v !== 'object') throw new SignalingError('Candidato ICE inválido');
  const c = v as Record<string, unknown>;
  if (typeof c.candidate !== 'string' || c.candidate.length > 2_000) throw new SignalingError('Candidato ICE inválido');
  const idx = c.sdpMLineIndex;
  if (idx !== undefined && idx !== null && (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0)) {
    throw new SignalingError('sdpMLineIndex inválido');
  }
  return {
    candidate: c.candidate,
    ...(c.sdpMid !== undefined ? { sdpMid: c.sdpMid === null ? null : String(c.sdpMid).slice(0, 64) } : {}),
    ...(idx !== undefined ? { sdpMLineIndex: idx as number | null } : {}),
    ...(c.usernameFragment !== undefined ? { usernameFragment: c.usernameFragment === null ? null : String(c.usernameFragment).slice(0, 256) } : {}),
  };
}

/** Valida e normaliza uma mensagem recebida de um navegador (descarta campos desconhecidos). */
export function parseClientMessage(input: unknown): ClientSignalingMessage {
  if (!input || typeof input !== 'object') throw new SignalingError('Mensagem de sinalização inválida');
  const m = input as Record<string, unknown>;
  switch (m.type) {
    case 'call.request': {
      const context = m.context;
      if (typeof context !== 'string' || !(CALL_CONTEXTS as readonly string[]).includes(context)) {
        throw new SignalingError('Contexto do chamado inválido');
      }
      const note = optStr(m, 'note', MAX_NOTE);
      return { type: 'call.request', unitId: str(m, 'unitId'), context: context as CallContext, ...(note ? { note } : {}) };
    }
    case 'call.cancel':
      return { type: 'call.cancel', requestId: str(m, 'requestId') };
    case 'call.end':
      return { type: 'call.end', roomId: str(m, 'roomId') };
    case 'interpreter.status':
      if (m.status !== 'AVAILABLE' && m.status !== 'OFFLINE') throw new SignalingError('Status de intérprete inválido');
      return { type: 'interpreter.status', status: m.status };
    case 'rtc.offer':
    case 'rtc.answer':
      return { type: m.type, roomId: str(m, 'roomId'), sdp: str(m, 'sdp', MAX_SDP) };
    case 'rtc.ice':
      return { type: 'rtc.ice', roomId: str(m, 'roomId'), candidate: candidate(m.candidate) };
    default:
      throw new SignalingError(`Tipo de mensagem desconhecido: ${String(m.type)}`);
  }
}

export function isRtcMessage(m: SignalingMessage): m is RtcMessage {
  return m.type === 'rtc.offer' || m.type === 'rtc.answer' || m.type === 'rtc.ice';
}
