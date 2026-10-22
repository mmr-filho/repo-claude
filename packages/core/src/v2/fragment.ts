import { randomBytes, type Bytes } from '../bytes';
import { concatBytes } from './wire';

/*
 * Fragmentação para canais com pacote pequeno (SMS de dados ~130 B, Bluetooth ~20-512 B).
 *   parte = 0xF1 ‖ idQuadro(4) ‖ índice(1) ‖ total(1) ‖ pedaço
 */

const MARK = 0xf1;
export const FRAGMENT_HEADER = 7;
const MAX_PARTS = 64;

export function fragment(frame: Bytes, maxPacket: number): Bytes[] {
  if (maxPacket <= FRAGMENT_HEADER) throw new Error('pacote pequeno demais');
  const chunk = maxPacket - FRAGMENT_HEADER;
  const total = Math.max(1, Math.ceil(frame.length / chunk));
  if (total > MAX_PARTS) throw new Error('mensagem grande demais para este canal');
  const id = randomBytes(4);
  const parts: Bytes[] = [];
  for (let i = 0; i < total; i++) {
    parts.push(concatBytes(Uint8Array.of(MARK), id, Uint8Array.of(i, total), frame.slice(i * chunk, (i + 1) * chunk)));
  }
  return parts;
}

export function isFragment(packet: Bytes): boolean {
  return packet.length > FRAGMENT_HEADER && packet[0] === MARK;
}

/** Junta as partes (em qualquer ordem, com repetidas) e devolve o quadro quando completo. */
export class Reassembler {
  private pending = new Map<string, { total: number; parts: Map<number, Bytes>; at: number }>();

  constructor(private ttlMs = 10 * 60 * 1000, private now: () => number = Date.now) {}

  push(packet: Bytes): Bytes | undefined {
    if (!isFragment(packet)) return undefined;
    this.sweep();
    const id = Array.from(packet.slice(1, 5), (b) => b.toString(16).padStart(2, '0')).join('');
    const index = packet[5]!;
    const total = packet[6]!;
    if (total === 0 || total > MAX_PARTS || index >= total) return undefined;
    let entry = this.pending.get(id);
    if (!entry || entry.total !== total) {
      entry = { total, parts: new Map(), at: this.now() };
      this.pending.set(id, entry);
    }
    entry.parts.set(index, packet.slice(FRAGMENT_HEADER));
    if (entry.parts.size < total) return undefined;
    this.pending.delete(id);
    return concatBytes(...Array.from({ length: total }, (_, i) => entry!.parts.get(i)!));
  }

  private sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, e] of this.pending) if (e.at < cutoff) this.pending.delete(id);
  }

  get incomplete(): number {
    return this.pending.size;
  }
}
