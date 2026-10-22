import type { Bytes } from '../bytes';
import { RelayClient } from './relay-client';

/*
 * Meios de transporte. O quadro cifrado é o mesmo em todos; muda só o caminho.
 * Prioridade pelo que cada meio deixa de rastro:
 *   1. proximidade (Bluetooth / Wi-Fi Direct): nada fora dos dois aparelhos
 *   2. relé (internet): o relé vê IP e horário, não vê conteúdo nem identidades
 *   3. SMS de dados (Android): a operadora registra quem e quando; só com permissão do usuário, por contato
 */

export type TransportId = 'proximity' | 'relay' | 'sms';

export interface PeerAddress {
  /** Chave de cifra do contato (identificador estável). */
  box: string;
  relay?: { url: string; inbox: string };
  sms?: { phone: string };
  proximity?: { id: string };
}

export interface Transport {
  readonly id: TransportId;
  /** Quanto menor, mais privado. */
  readonly privacyRank: number;
  /** Deixa registro numa terceira parte (operadora). Exige permissão explícita do usuário para o contato. */
  readonly leavesCarrierRecord?: boolean;
  /** Tamanho para arredondar a carga (0 = sem preenchimento, para caber em SMS). */
  readonly padTo: number;
  isAvailable(): Promise<boolean>;
  canReach(peer: PeerAddress): boolean;
  send(peer: PeerAddress, frame: Bytes): Promise<void>;
}

export interface SendReport {
  via: TransportId;
  /** Meios tentados que falharam antes do que funcionou. */
  failed: Array<{ id: TransportId; reason: string }>;
}

export class NoTransportError extends Error {
  constructor(
    public failed: Array<{ id: TransportId; reason: string }>,
    /** O único meio que sobrou é um que deixa registro na operadora e o usuário ainda não permitiu. */
    public needsConsent: TransportId | undefined,
  ) {
    super(needsConsent ? 'Só há um meio que deixa registro na operadora e ele não foi autorizado para este contato' : 'Nenhum meio de envio disponível');
    this.name = 'NoTransportError';
  }
}

export class TransportManager {
  constructor(
    private transports: Transport[],
    private consent: (box: string, transport: TransportId) => boolean,
  ) {}

  add(t: Transport): void {
    this.transports = [...this.transports.filter((x) => x.id !== t.id), t];
  }

  get ids(): TransportId[] {
    return [...this.transports].sort((a, b) => a.privacyRank - b.privacyRank).map((t) => t.id);
  }

  /** Tenta do meio mais privado para o menos; `build(padTo)` monta o quadro no tamanho que cada meio quer. */
  async send(peer: PeerAddress, build: (padTo: number) => Bytes): Promise<SendReport> {
    const failed: SendReport['failed'] = [];
    let blocked: TransportId | undefined;
    for (const t of [...this.transports].sort((a, b) => a.privacyRank - b.privacyRank)) {
      if (t.leavesCarrierRecord && (!t.canReach(peer) || !this.consent(peer.box, t.id))) {
        // Opção que existe neste aparelho mas não pode ser usada sem a permissão (e o número) do usuário: a interface precisa perguntar.
        if (await t.isAvailable().catch(() => false)) blocked = t.id;
        continue;
      }
      if (!t.canReach(peer)) continue;
      try {
        if (!(await t.isAvailable())) {
          failed.push({ id: t.id, reason: 'indisponível' });
          continue;
        }
        await t.send(peer, build(t.padTo));
        return { via: t.id, failed };
      } catch (err) {
        failed.push({ id: t.id, reason: err instanceof Error ? err.message : 'erro' });
      }
    }
    throw new NoTransportError(failed, blocked);
  }
}

/** Relé pela internet. */
export class RelayTransport implements Transport {
  readonly id = 'relay' as const;
  readonly privacyRank = 2;
  readonly padTo = 128;

  constructor(private client: RelayClient) {}

  async isAvailable() {
    return true;
  }

  canReach(peer: PeerAddress) {
    return !!peer.relay;
  }

  send(peer: PeerAddress, frame: Bytes) {
    return this.client.send(peer.relay!.url, peer.relay!.inbox, frame);
  }
}
