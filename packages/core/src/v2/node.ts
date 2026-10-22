import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { b64, randomBytes, utf8Decode, utf8Encode, wipe, type Bytes } from '../bytes';
import {
  DAY_MS,
  countersignLink,
  decodeCode,
  encodeCode,
  issueDescriptor,
  issueLinkRevocation,
  issueMemberCert,
  issueRevocation,
  otherParty,
  proposeLink,
  verifyDescriptor,
  verifyLinkCert,
  verifyLinkRevocation,
  verifyMemberCert,
  verifyPartialLink,
  verifyRevocation,
  type Invite,
  type LinkCert,
  type LinkRevocation,
  type MemberCert,
  type NetworkDescriptor,
  type PartialLink,
  type Revocation,
} from './certs';
import { PayloadType, UnknownSenderError, openFrame, sealFrame } from './frame';
import { generateIdentity2, generateSignKeys, refOf, sign, verify, type Identity2, type SignKeys } from './keys';
import { RelayClient } from './relay-client';
import { NoTransportError, RelayTransport, TransportManager, type PeerAddress, type Transport, type TransportId } from './transport';
import { createVault, openState, openVault, sealState, type VaultOptions, type VaultSecrets } from './vault';
import { concatBytes, equalBytes, hex, unhex, varintDecode, varintEncode } from './wire';
import type { Role } from '../types';

/*
 * Nó local do Sigilo v2: tudo que antes o servidor fazia por conta e risco agora acontece no aparelho.
 *   - o administrador é a autoridade da rede (assina certificados);
 *   - cada aparelho confere as assinaturas e decide em quem confiar;
 *   - o relé só carrega quadros cifrados; a leitura apaga a mensagem da caixa postal.
 */

// ───────── Armazenamento local ─────────

export type Slot = 'vault' | 'queue' | 'meta' | 'state';

/** Quatro compartimentos. No app: vault/queue/meta no Keychain/Keystore e state em arquivo (já cifrado). */
export interface LocalStore {
  get(slot: Slot): Promise<string | null>;
  set(slot: Slot, value: string): Promise<void>;
  remove(slot: Slot): Promise<void>;
}

export class MemoryLocalStore implements LocalStore {
  data = new Map<Slot, string>();
  async get(slot: Slot) {
    return this.data.get(slot) ?? null;
  }
  async set(slot: Slot, value: string) {
    this.data.set(slot, value);
  }
  async remove(slot: Slot) {
    this.data.delete(slot);
  }
}

export interface NodeDeps {
  store: LocalStore;
  relay: RelayClient;
  /** Outros meios além do relé (proximidade, SMS). */
  transports?: Transport[];
  now?: () => number;
  vault?: VaultOptions;
}

// ───────── Estado ─────────

export interface NetworkInfo {
  net: string;
  authority: string;
  name: string;
  adminBox: string;
  adminInbox: string;
  relay: string;
}

interface ContactRecord {
  cert: MemberCert;
  trust: 'own' | 'linked';
  /** Eu já mandei a minha identidade (certificado) para este contato. */
  introduced: boolean;
  allowSms: boolean;
  phone?: string;
}

interface OutboxEntry {
  id: string;
  peer: string;
  text: string;
  sentAt: number;
  attempts: number;
}

interface PendingProposal {
  id: string;
  descriptor: NetworkDescriptor;
  proposal: PartialLink;
  at: number;
}

interface AdminState {
  pendingInvites: Array<{ token: string; name: string; role: Role; exp: number }>;
  members: Record<string, MemberCert>;
  peers: Record<string, NetworkDescriptor>;
  proposals: PendingProposal[];
  outgoing: Array<{ net: string; name: string; at: number }>;
}

interface NodeState {
  v: 1;
  name: string;
  network?: NetworkInfo;
  me?: MemberCert;
  /** Meu acesso foi revogado pelo administrador. */
  revoked?: boolean;
  enrollment?: { token: string; sentAt: number; invite: Invite };
  links: LinkCert[];
  revocations: Revocation[];
  unlinks: LinkRevocation[];
  contacts: Record<string, ContactRecord>;
  seen: string[];
  outbox: OutboxEntry[];
  receipts: Array<{ peer: string; id: string }>;
  renewAskedAt?: number;
  admin?: AdminState;
}

interface QueueRecord {
  qid: string;
  relay: string;
  secret: string;
  pub: string;
}

interface Meta {
  v: 1;
  name: string;
  networkName?: string;
  qid: string;
  relay: string;
  role: Role | 'pending';
}

// ───────── Tipos públicos ─────────

export interface ChatMessage {
  id: string;
  peer: string;
  direction: 'in' | 'out';
  text: string;
  sentAt: number;
}

export interface SentMessage extends ChatMessage {
  status: 'sent' | 'queued' | 'read';
  via?: TransportId;
}

export interface ContactView {
  box: string;
  name: string;
  role: Role;
  networkName: string;
  sameNetwork: boolean;
  allowSms: boolean;
  phone?: string;
}

export interface PollResult {
  /** Mensagens ainda não lidas, por contato (sem conteúdo). */
  unread: Record<string, number>;
  /** Ids de mensagens minhas que o destinatário já leu. */
  receipts: string[];
  /** O que mudou: 'enrolled' | 'roster' | 'link' | 'proposal' | 'revoked' | 'renewed'. */
  events: string[];
  dropped: number;
}

export interface SendResult {
  id: string;
  status: 'sent' | 'queued';
  via?: TransportId;
  /** Só havia um meio que deixa registro na operadora e ele não foi autorizado para este contato. */
  needsConsent?: TransportId;
}

export class LockedError extends Error {
  constructor() {
    super('O cofre está trancado. Digite a senha.');
    this.name = 'LockedError';
  }
}

export class UntrustedContactError extends Error {
  constructor(reason: string) {
    super(`Contato não é confiável: ${reason}`);
    this.name = 'UntrustedContactError';
  }
}

// ───────── Utilidades ─────────

const enc = (o: unknown) => utf8Encode(JSON.stringify(o));
const dec = <T>(b: Bytes) => JSON.parse(utf8Decode(b)) as T;
const MAX_SEEN = 2000;
const UNRESOLVED_TTL_MS = 60 * 60 * 1000;
const RENEW_BEFORE_MS = 7 * DAY_MS;
const RENEW_GRACE_MS = 14 * DAY_MS;
const ROSTER_CHUNK = 10;
const INVITE_TTL_MS = 7 * DAY_MS;

interface Incoming extends ChatMessage {
  ack: () => Promise<void>;
}

export class LocalNode {
  private identity?: Identity2;
  private authority?: SignKeys;
  private queue?: QueueRecord;
  private s!: NodeState;
  private incoming = new Map<string, Incoming>();
  private sent = new Map<string, SentMessage>();
  private unresolvedSince = new Map<string, number>();
  private manager: TransportManager;
  private now: () => number;

  private constructor(
    private deps: NodeDeps,
    private meta: Meta,
  ) {
    this.now = deps.now ?? Date.now;
    this.manager = new TransportManager([new RelayTransport(deps.relay), ...(deps.transports ?? [])], (box, id) =>
      id === 'sms' ? !!this.s?.contacts[box]?.allowSms : true,
    );
  }

  // ───────── criação ─────────

  /** O administrador cria a rede: gera a chave da autoridade (que fica só neste aparelho) e a própria identidade. */
  static async createNetwork(deps: NodeDeps, o: { password: string; adminName: string; networkName: string; relayUrl: string }): Promise<LocalNode> {
    const now = (deps.now ?? Date.now)();
    const id = generateIdentity2();
    const authority = generateSignKeys();
    const queue = LocalNode.newQueue(o.relayUrl);
    await deps.relay.createQueue(o.relayUrl, queue.qid, LocalNode.queueKeys(queue));

    const boxPub = b64.encode(id.box.publicKey);
    const descriptor = issueDescriptor(authority, { name: o.networkName, adminBox: boxPub, adminInbox: queue.qid, relay: o.relayUrl });
    const me = issueMemberCert(
      authority,
      { box: boxPub, sign: b64.encode(id.sign.publicKey), name: o.adminName, role: 'admin', inbox: queue.qid, relay: o.relayUrl },
      now,
    );
    const meta: Meta = { v: 1, name: o.adminName, networkName: o.networkName, qid: queue.qid, relay: o.relayUrl, role: 'admin' };
    const node = new LocalNode(deps, meta);
    node.identity = id;
    node.authority = authority;
    node.queue = queue;
    node.s = {
      v: 1,
      name: o.adminName,
      network: { net: descriptor.net, authority: descriptor.authority, name: o.networkName, adminBox: boxPub, adminInbox: queue.qid, relay: o.relayUrl },
      me,
      links: [],
      revocations: [],
      unlinks: [],
      contacts: {},
      seen: [],
      outbox: [],
      receipts: [],
      admin: { pendingInvites: [], members: { [boxPub]: me }, peers: {}, proposals: [], outgoing: [] },
    };
    await deps.store.set(
      'vault',
      JSON.stringify(await createVault(o.password, { box: b64.encode(id.box.secretKey), sign: b64.encode(id.sign.secretKey), authority: b64.encode(authority.secretKey) }, deps.vault)),
    );
    await node.persistAll();
    return node;
  }

  /** Entrada numa rede com o convite do administrador. A resposta chega depois, por `poll()`. */
  static async join(deps: NodeDeps, o: { password: string; inviteCode: string }): Promise<LocalNode> {
    const now = (deps.now ?? Date.now)();
    const invite = decodeCode<Invite>('invite', o.inviteCode);
    if (invite.v !== 1 || invite.exp <= now) throw new Error('Convite vencido ou inválido');
    const id = generateIdentity2();
    const queue = LocalNode.newQueue(invite.relay);
    await deps.relay.createQueue(invite.relay, queue.qid, LocalNode.queueKeys(queue));

    const meta: Meta = { v: 1, name: '', networkName: invite.name, qid: queue.qid, relay: invite.relay, role: 'pending' };
    const node = new LocalNode(deps, meta);
    node.identity = id;
    node.queue = queue;
    node.s = {
      v: 1,
      name: '',
      network: { net: invite.net, authority: invite.authority, name: invite.name, adminBox: invite.adminBox, adminInbox: invite.adminInbox, relay: invite.relay },
      links: [],
      revocations: [],
      unlinks: [],
      contacts: {},
      seen: [],
      outbox: [],
      receipts: [],
      enrollment: { token: invite.token, sentAt: now, invite },
    };
    await deps.store.set(
      'vault',
      JSON.stringify(await createVault(o.password, { box: b64.encode(id.box.secretKey), sign: b64.encode(id.sign.secretKey) }, deps.vault)),
    );
    await node.persistAll();
    await node.sendEnrollRequest();
    return node;
  }

  /** Abre o que está gravado no aparelho. O nó começa TRANCADO: só `unlock(senha)` libera a leitura. */
  static async load(deps: NodeDeps): Promise<LocalNode | null> {
    const [metaRaw, queueRaw] = await Promise.all([deps.store.get('meta'), deps.store.get('queue')]);
    if (!metaRaw || !queueRaw) return null;
    const node = new LocalNode(deps, JSON.parse(metaRaw) as Meta);
    node.queue = JSON.parse(queueRaw) as QueueRecord;
    return node;
  }

  private static newQueue(relay: string): QueueRecord {
    const k = generateSignKeys();
    return { qid: b64.encode(randomBytes(16)), relay, secret: b64.encode(k.secretKey), pub: b64.encode(k.publicKey) };
  }

  private static queueKeys(q: QueueRecord): SignKeys {
    return { secretKey: b64.decode(q.secret), publicKey: b64.decode(q.pub) };
  }

  // ───────── cofre ─────────

  get isUnlocked(): boolean {
    return !!this.identity;
  }

  get profile(): Readonly<Meta> {
    return this.meta;
  }

  private need(): Identity2 {
    if (!this.identity) throw new LockedError();
    return this.identity;
  }

  /** Digite a senha. Lança WrongPasswordError se estiver errada. */
  async unlock(password: string): Promise<void> {
    if (this.identity) return;
    const raw = await this.deps.store.get('vault');
    if (!raw) throw new Error('Nenhuma identidade neste aparelho');
    const secrets: VaultSecrets = await openVault(password, JSON.parse(raw), this.deps.vault);
    const box = b64.decode(secrets.box);
    const signSecret = b64.decode(secrets.sign);
    this.identity = { box: { secretKey: box, publicKey: x25519.getPublicKey(box) }, sign: { secretKey: signSecret, publicKey: ed25519.getPublicKey(signSecret) } };
    if (secrets.authority) {
      const a = b64.decode(secrets.authority);
      this.authority = { secretKey: a, publicKey: ed25519.getPublicKey(a) };
    }
    const sealed = await this.deps.store.get('state');
    if (!sealed) throw new Error('Estado do aplicativo ausente neste aparelho');
    this.s = JSON.parse(openState(box, sealed)) as NodeState;
  }

  /** Apaga as chaves e o texto da memória. As mensagens continuam cifradas no relé até serem lidas. */
  lock(): void {
    if (this.identity) wipe(this.identity.box.secretKey, this.identity.sign.secretKey);
    if (this.authority) wipe(this.authority.secretKey);
    this.identity = undefined;
    this.authority = undefined;
    this.incoming.clear();
    this.sent.clear();
    this.unresolvedSince.clear();
    this.s = undefined as unknown as NodeState;
  }

  /** Quantas mensagens aguardam, SEM abrir o cofre (só a chave da caixa postal, que não lê conteúdo). */
  async pendingCount(): Promise<number> {
    const q = this.queue!;
    return this.deps.relay.count(q.relay, q.qid, LocalNode.queueKeys(q));
  }

  private async persistAll(): Promise<void> {
    this.need();
    await this.deps.store.set('queue', JSON.stringify(this.queue));
    await this.deps.store.set('meta', JSON.stringify(this.meta));
    await this.persist();
  }

  private async persist(): Promise<void> {
    const id = this.need();
    if (this.s.seen.length > MAX_SEEN) this.s.seen = this.s.seen.slice(-MAX_SEEN);
    await this.deps.store.set('state', sealState(id.box.secretKey, JSON.stringify(this.s)));
  }

  // ───────── informação ─────────

  get isAdmin(): boolean {
    return !!this.authority && !!this.s?.admin;
  }
  get isEnrolled(): boolean {
    return !!this.s?.me;
  }
  get isRevoked(): boolean {
    return !!this.s?.revoked;
  }
  get me(): MemberCert | undefined {
    return this.s?.me;
  }
  get network(): NetworkInfo | undefined {
    return this.s?.network;
  }
  get myBox(): string {
    return b64.encode(this.need().box.publicKey);
  }

  contacts(): ContactView[] {
    this.need();
    const myNet = this.s.network?.net;
    return Object.values(this.s.contacts)
      .filter((c) => this.trustOf(c.cert).ok)
      .map((c) => ({
        box: c.cert.box,
        name: c.cert.name,
        role: c.cert.role,
        networkName: c.trust === 'own' ? (this.s.network?.name ?? '') : (this.linkedName(c.cert.net) ?? ''),
        sameNetwork: c.cert.net === myNet,
        allowSms: c.allowSms,
        phone: c.phone,
      }))
      .sort((a, b) => Number(b.sameNetwork) - Number(a.sameNetwork) || a.name.localeCompare(b.name));
  }

  private linkedName(net: string): string | undefined {
    const link = this.s.links.find((l) => otherParty(l, this.s.network?.net ?? '')?.net === net);
    return link ? otherParty(link, this.s.network!.net)?.name : undefined;
  }

  /** Autoriza (ou não) o SMS para um contato, e guarda o número. O SMS deixa registro na operadora. */
  async setSmsConsent(box: string, allow: boolean, phone?: string): Promise<void> {
    const c = this.s.contacts[box];
    if (!c) throw new Error('Contato desconhecido');
    c.allowSms = allow;
    if (phone !== undefined) c.phone = phone;
    await this.persist();
  }

  // ───────── confiança ─────────

  private activeLinks(): LinkCert[] {
    const now = this.now();
    return this.s.links.filter((l) => {
      if (!verifyLinkCert(l, now).ok) return false;
      const peer = otherParty(l, this.s.network?.net ?? '');
      if (!peer) return false;
      const myNet = this.s.network!.net;
      return !this.s.unlinks.some((u) => ((u.net === peer.net && u.peerNet === myNet) || (u.net === myNet && u.peerNet === peer.net)) && u.iat >= l.iat);
    });
  }

  /** Decide se um certificado merece confiança agora: assinatura, validade, rede própria ou vinculada, revogação. */
  private trustOf(cert: MemberCert): { ok: true; trust: 'own' | 'linked' } | { ok: false; reason: string } {
    const net = this.s.network;
    if (!net) return { ok: false, reason: 'sem rede' };
    const now = this.now();
    if (this.s.revocations.some((r) => r.target === cert.box && r.net === cert.net)) return { ok: false, reason: 'revogado' };
    if (cert.net === net.net) {
      const v = verifyMemberCert(cert, b64.decode(net.authority), now);
      return v.ok ? { ok: true, trust: 'own' } : { ok: false, reason: v.reason };
    }
    for (const link of this.activeLinks()) {
      const peer = otherParty(link, net.net);
      if (peer?.net !== cert.net) continue;
      const v = verifyMemberCert(cert, b64.decode(peer.authority), now);
      return v.ok ? { ok: true, trust: 'linked' } : { ok: false, reason: v.reason };
    }
    return { ok: false, reason: 'rede sem vínculo' };
  }

  private addContact(cert: MemberCert): 'added' | 'updated' | 'same' | 'rejected' {
    if (cert.box === this.myBox) return 'same';
    const t = this.trustOf(cert);
    if (!t.ok) return 'rejected';
    const prev = this.s.contacts[cert.box];
    if (prev && prev.cert.iat >= cert.iat) return 'same';
    this.s.contacts[cert.box] = { cert, trust: t.trust, introduced: prev?.introduced ?? false, allowSms: prev?.allowSms ?? false, phone: prev?.phone };
    return prev ? 'updated' : 'added';
  }

  /** Reavalia contatos depois de revogações, vínculos desfeitos ou vencimentos. */
  private pruneContacts(): void {
    for (const [box, c] of Object.entries(this.s.contacts)) if (!this.trustOf(c.cert).ok) delete this.s.contacts[box];
    for (const [id, m] of this.incoming) if (!this.s.contacts[m.peer]) this.incoming.delete(id);
  }

  private addressOf(c: ContactRecord): PeerAddress {
    return {
      box: c.cert.box,
      relay: { url: c.cert.relay, inbox: c.cert.inbox },
      sms: c.phone ? { phone: c.phone } : undefined,
    };
  }

  // ───────── envio ─────────

  private async emit(addr: PeerAddress, type: (typeof PayloadType)[keyof typeof PayloadType], body: Bytes, extra: { senderKey?: boolean } = {}): Promise<TransportId> {
    const id = this.need();
    const to = b64.decode(addr.box);
    const report = await this.manager.send(addr, (padTo) =>
      sealFrame({ payload: { type, body, senderKey: extra.senderKey ? id.box.publicKey : undefined }, sender: id.box, recipientBox: to, padTo }),
    );
    return report.via;
  }

  /** Envia uma mensagem. Sem meio disponível, fica na fila (cifrada com o cofre) e sai quando houver. */
  async send(peerBox: string, text: string): Promise<SendResult> {
    this.need();
    const body = text.trim();
    if (!body) throw new Error('Mensagem vazia');
    if (this.s.revoked) throw new Error('Seu acesso foi revogado pelo administrador da rede');
    if (!this.s.me) throw new Error('Esta conta ainda não foi aprovada pelo administrador');
    const c = this.s.contacts[peerBox];
    if (!c) throw new Error('Contato desconhecido');
    const t = this.trustOf(c.cert);
    if (!t.ok) throw new UntrustedContactError(t.reason);
    const idBytes = randomBytes(8);
    const id = hex(idBytes);
    const entry: OutboxEntry = { id, peer: peerBox, text: body, sentAt: this.now(), attempts: 0 };
    const msg: SentMessage = { id, peer: peerBox, direction: 'out', text: body, sentAt: entry.sentAt, status: 'queued' };
    this.sent.set(id, msg);
    const r = await this.deliver(entry);
    msg.status = r.status;
    msg.via = r.via;
    if (r.status === 'queued') {
      this.s.outbox.push(entry);
      await this.persist();
    }
    return { id, ...r };
  }

  private chatBody(e: OutboxEntry): Bytes {
    return concatBytes(unhex(e.id), varintEncode(Math.floor(e.sentAt / 1000)), utf8Encode(e.text));
  }

  private async deliver(e: OutboxEntry): Promise<{ status: 'sent' | 'queued'; via?: TransportId; needsConsent?: TransportId }> {
    const c = this.s.contacts[e.peer];
    if (!c) return { status: 'queued' };
    try {
      if (!c.introduced) {
        await this.emit(this.addressOf(c), PayloadType.Intro, enc(this.s.me!), { senderKey: true });
        c.introduced = true;
      }
      const via = await this.emit(this.addressOf(c), PayloadType.Chat, this.chatBody(e));
      return { status: 'sent', via };
    } catch (err) {
      e.attempts++;
      if (err instanceof NoTransportError) return { status: 'queued', needsConsent: err.needsConsent };
      return { status: 'queued' };
    }
  }

  /** Reenvia o que ficou na fila (mensagens e recibos). */
  async flushOutbox(): Promise<number> {
    this.need();
    let sent = 0;
    const left: OutboxEntry[] = [];
    for (const e of this.s.outbox) {
      const r = await this.deliver(e);
      if (r.status === 'sent') {
        sent++;
        const m = this.sent.get(e.id);
        if (m && m.status !== 'read') {
          m.status = 'sent';
          m.via = r.via;
        }
      } else left.push(e);
    }
    this.s.outbox = left;
    const pendingReceipts: typeof this.s.receipts = [];
    for (const r of this.s.receipts) {
      const c = this.s.contacts[r.peer];
      if (!c) continue;
      try {
        await this.emit(this.addressOf(c), PayloadType.Receipt, unhex(r.id));
      } catch {
        pendingReceipts.push(r);
      }
    }
    this.s.receipts = pendingReceipts;
    await this.persist();
    return sent;
  }

  // ───────── recebimento ─────────

  /** Busca e processa a caixa postal. Mensagens de conversa FICAM no relé até serem lidas. */
  async poll(): Promise<PollResult> {
    this.need();
    const q = this.queue!;
    const result: PollResult = { unread: {}, receipts: [], events: [], dropped: 0 };
    const key = LocalNode.queueKeys(q);
    await this.maybeRenew();
    const msgs = await this.deps.relay.list(q.relay, q.qid, key);
    for (const m of msgs) {
      await this.process(m.frame, { ack: () => this.deps.relay.ack(q.relay, q.qid, key, m.id), key: m.id, ts: m.ts }, result);
    }
    await this.flushOutbox();
    for (const m of this.incoming.values()) result.unread[m.peer] = (result.unread[m.peer] ?? 0) + 1;
    await this.persist();
    return result;
  }

  /** Entrada por outros meios (SMS, proximidade). O quadro é o mesmo; não há nada a apagar no relé. */
  async receiveFrame(frame: Bytes): Promise<PollResult> {
    this.need();
    const result: PollResult = { unread: {}, receipts: [], events: [], dropped: 0 };
    await this.process(frame, { ack: async () => {}, key: hex(frame.slice(0, 12)), ts: this.now() }, result);
    for (const m of this.incoming.values()) result.unread[m.peer] = (result.unread[m.peer] ?? 0) + 1;
    await this.persist();
    return result;
  }

  private candidateSenders(ref: Bytes): Bytes[] {
    const out: Bytes[] = [];
    const add = (boxB64: string | undefined) => {
      if (!boxB64) return;
      const k = b64.decode(boxB64);
      if (equalBytes(refOf(k), ref) && !out.some((o) => equalBytes(o, k))) out.push(k);
    };
    for (const box of Object.keys(this.s.contacts)) add(box);
    add(this.s.network?.adminBox);
    for (const p of Object.values(this.s.admin?.peers ?? {})) add(p.adminBox);
    return out;
  }

  private async process(frame: Bytes, src: { ack: () => Promise<void>; key: string; ts: number }, out: PollResult): Promise<void> {
    const me = this.need();
    let opened;
    try {
      opened = openFrame({ frame, self: me.box, knownSenders: (ref) => this.candidateSenders(ref) });
    } catch (err) {
      if (err instanceof UnknownSenderError) {
        // Pode ser o certificado do remetente ainda a caminho: espera um pouco antes de desistir.
        const since = this.unresolvedSince.get(src.key) ?? this.now();
        this.unresolvedSince.set(src.key, since);
        if (this.now() - since < UNRESOLVED_TTL_MS && this.now() - src.ts < UNRESOLVED_TTL_MS) return;
        this.unresolvedSince.delete(src.key);
      }
      out.dropped++;
      await src.ack();
      return;
    }
    this.unresolvedSince.delete(src.key);
    const sender = b64.encode(opened.sender);
    try {
      switch (opened.type) {
        case PayloadType.Chat:
          return await this.onChat(opened.body, sender, src, out);
        case PayloadType.Receipt: {
          const id = hex(opened.body);
          const m = this.sent.get(id);
          if (m) {
            m.status = 'read';
            m.text = '';
          }
          out.receipts.push(id);
          break;
        }
        case PayloadType.Recall: {
          const id = hex(opened.body);
          const m = this.incoming.get(id);
          if (m && m.peer === sender) {
            await m.ack();
            this.incoming.delete(id);
          }
          break;
        }
        case PayloadType.Intro:
          this.onIntro(dec<MemberCert>(opened.body), sender, out);
          break;
        case PayloadType.Roster:
          await this.onRoster(dec<RosterUpdate>(opened.body), sender, out);
          break;
        case PayloadType.EnrollRequest:
          await this.onEnrollRequest(dec<EnrollRequestBody>(opened.body), sender, out);
          break;
        case PayloadType.EnrollResponse:
          await this.onEnrollResponse(dec<EnrollResponseBody>(opened.body), sender, out);
          break;
        case PayloadType.RenewRequest:
          await this.onRenewRequest(dec<MemberCert>(opened.body), sender);
          break;
        case PayloadType.LinkProposal:
          await this.onLinkProposal(dec<LinkProposalBody>(opened.body), sender, out);
          break;
        case PayloadType.LinkAccepted:
          await this.onLinkAccepted(dec<{ link: LinkCert; descriptor: NetworkDescriptor }>(opened.body), sender, out);
          break;
        default:
          out.dropped++;
      }
    } catch {
      out.dropped++; // corpo malformado ou não autorizado: descarta
    }
    await src.ack();
  }

  private async onChat(body: Bytes, sender: string, src: { ack: () => Promise<void> }, out: PollResult): Promise<void> {
    const c = this.s.contacts[sender];
    const idBytes = body.slice(0, 8);
    const id = hex(idBytes);
    if (!c || !this.trustOf(c.cert).ok || this.s.revoked) {
      out.dropped++;
      await src.ack();
      return;
    }
    if (this.s.seen.includes(id)) {
      await src.ack(); // repetida (chegou por dois meios)
      return;
    }
    if (this.incoming.has(id)) return;
    const { value: secs, next } = varintDecode(body, 8);
    this.incoming.set(id, { id, peer: sender, direction: 'in', text: utf8Decode(body.slice(next)), sentAt: secs * 1000, ack: src.ack });
  }

  private onIntro(cert: MemberCert, sender: string, out: PollResult): void {
    if (cert.box !== sender) return; // só vale se quem se apresenta é o dono do certificado
    if (this.addContact(cert) === 'added') out.events.push('roster');
  }

  // ───────── conversa ─────────

  /**
   * Entrega ao app as mensagens recebidas deste contato e as APAGA do relé (e manda o recibo de leitura).
   * Depois disto, o texto só existe na memória de quem chamou.
   */
  async openConversation(peerBox: string): Promise<{ messages: ChatMessage[]; sent: SentMessage[] }> {
    this.need();
    const mine = [...this.incoming.values()].filter((m) => m.peer === peerBox).sort((a, b) => a.sentAt - b.sentAt);
    const messages: ChatMessage[] = [];
    for (const m of mine) {
      await m.ack();
      this.incoming.delete(m.id);
      this.s.seen.push(m.id);
      this.s.receipts.push({ peer: m.peer, id: m.id });
      messages.push({ id: m.id, peer: m.peer, direction: 'in', text: m.text, sentAt: m.sentAt });
    }
    if (mine.length) await this.flushOutbox();
    else await this.persist();
    return { messages, sent: [...this.sent.values()].filter((m) => m.peer === peerBox) };
  }

  /** Apagar para todos: só adianta se o destinatário ainda não leu. */
  async recall(id: string): Promise<void> {
    const m = this.sent.get(id);
    if (!m || m.status === 'read') throw new Error('Mensagem já lida ou desconhecida');
    const c = this.s.contacts[m.peer];
    this.s.outbox = this.s.outbox.filter((e) => e.id !== id);
    this.sent.delete(id);
    if (c) await this.emit(this.addressOf(c), PayloadType.Recall, unhex(id)).catch(() => undefined);
    await this.persist();
  }

  // ───────── entrada na rede ─────────

  private async sendEnrollRequest(): Promise<void> {
    const id = this.need();
    const en = this.s.enrollment!;
    const q = this.queue!;
    const box = b64.encode(id.box.publicKey);
    const signPub = b64.encode(id.sign.publicKey);
    const pop = b64.encode(sign(id.sign.secretKey, utf8Encode(`sigilo/v2/enroll\n${en.token}\n${box}\n${signPub}\n${q.qid}`)));
    const body: EnrollRequestBody = { token: en.token, box, sign: signPub, inbox: q.qid, relay: q.relay, pop };
    await this.deps.relay.send(
      en.invite.relay,
      en.invite.adminInbox,
      sealFrame({ payload: { type: PayloadType.EnrollRequest, body: enc(body), senderKey: id.box.publicKey }, sender: id.box, recipientBox: b64.decode(en.invite.adminBox), padTo: 128 }),
    );
  }

  /** Reenvia o pedido de entrada (se o relé estava fora do ar). */
  async retryEnrollment(): Promise<void> {
    this.need();
    if (this.s.enrollment) await this.sendEnrollRequest();
  }

  private async onEnrollRequest(req: EnrollRequestBody, sender: string, out: PollResult): Promise<void> {
    if (!this.isAdmin) return;
    const admin = this.s.admin!;
    const now = this.now();
    const invite = admin.pendingInvites.find((i) => i.token === req.token && i.exp > now);
    if (!invite || req.box !== sender) return;
    const popOk = verify(b64.decode(req.sign), utf8Encode(`sigilo/v2/enroll\n${req.token}\n${req.box}\n${req.sign}\n${req.inbox}`), b64.decode(req.pop));
    if (!popOk) return;
    const cert = issueMemberCert(this.authority!, { box: req.box, sign: req.sign, name: invite.name, role: invite.role, inbox: req.inbox, relay: req.relay }, now);
    admin.pendingInvites = admin.pendingInvites.filter((i) => i.token !== req.token);
    admin.members[cert.box] = cert;
    this.addContact(cert);
    const addr: PeerAddress = { box: cert.box, relay: { url: cert.relay, inbox: cert.inbox } };
    const response: EnrollResponseBody = { cert, links: this.activeLinks(), revocations: this.s.revocations, unlinks: this.s.unlinks };
    await this.emit(addr, PayloadType.EnrollResponse, enc(response));
    // O novo membro conhece todos; os antigos passam a conhecer o novo.
    await this.sendRosterTo(addr, [...Object.values(admin.members), ...this.foreignCerts()]);
    await this.broadcastRoster({ certs: [cert] }, cert.box);
    out.events.push('roster');
  }

  private async onEnrollResponse(res: EnrollResponseBody, sender: string, out: PollResult): Promise<void> {
    const me = this.need();
    const net = this.s.network;
    if (!net || sender !== net.adminBox) return; // só o administrador da rede pode me responder
    const authority = b64.decode(net.authority);
    const cert = res.cert;
    if (cert.box !== b64.encode(me.box.publicKey) || cert.sign !== b64.encode(me.sign.publicKey)) return;
    if (!verifyMemberCert(cert, authority, this.now()).ok) return;
    const renewed = !!this.s.me;
    this.s.me = cert;
    this.s.name = cert.name;
    this.s.enrollment = undefined;
    this.s.renewAskedAt = undefined;
    this.meta.name = cert.name;
    this.meta.role = cert.role;
    await this.deps.store.set('meta', JSON.stringify(this.meta));
    await this.mergeRoster({ links: res.links, revocations: res.revocations, unlinks: res.unlinks }, out);
    this.pruneContacts();
    out.events.push(renewed ? 'renewed' : 'enrolled');
  }

  private async maybeRenew(): Promise<void> {
    const me = this.s.me;
    const net = this.s.network;
    if (!me || !net || this.s.revoked) return;
    const now = this.now();
    if (me.exp - now > RENEW_BEFORE_MS) return;

    // A autoridade assina o próprio certificado de administrador (senão a rede inteira deixaria de confiar nele).
    if (this.isAdmin) {
      const fresh = issueMemberCert(this.authority!, { box: me.box, sign: me.sign, name: me.name, role: me.role, inbox: me.inbox, relay: me.relay }, now);
      this.s.me = fresh;
      this.s.admin!.members[fresh.box] = fresh;
      await this.persist();
      await this.broadcastRoster({ certs: [fresh] });
      await this.broadcastToPeerAdmins({ certs: [fresh] });
      return;
    }

    if (this.s.renewAskedAt && now - this.s.renewAskedAt < DAY_MS) return;
    this.s.renewAskedAt = now;
    try {
      await this.emit({ box: net.adminBox, relay: { url: net.relay, inbox: net.adminInbox } }, PayloadType.RenewRequest, enc(me));
    } catch {
      /* tenta de novo no próximo ciclo */
    }
  }

  private async onRenewRequest(cert: MemberCert, sender: string): Promise<void> {
    if (!this.isAdmin) return;
    const admin = this.s.admin!;
    const known = admin.members[cert.box];
    const now = this.now();
    // Precisa ser membro conhecido, não revogado, com certificado nosso (vencido há pouco ainda serve).
    if (!known || cert.box !== sender || this.s.revocations.some((r) => r.target === cert.box)) return;
    if (!verifyMemberCert(cert, this.authority!.publicKey, Math.min(now, cert.exp - 1)).ok || now - cert.exp > RENEW_GRACE_MS) return;
    const fresh = issueMemberCert(this.authority!, { box: cert.box, sign: cert.sign, name: known.name, role: known.role, inbox: cert.inbox, relay: cert.relay }, now);
    admin.members[fresh.box] = fresh;
    await this.emit({ box: fresh.box, relay: { url: fresh.relay, inbox: fresh.inbox } }, PayloadType.EnrollResponse, enc({ cert: fresh } satisfies EnrollResponseBody));
    await this.broadcastRoster({ certs: [fresh] }, fresh.box);
  }

  // ───────── administração ─────────

  private needAdmin(): AdminState {
    this.need();
    if (!this.isAdmin) throw new Error('Apenas o administrador da rede');
    return this.s.admin!;
  }

  /** Convite para uma pessoa entrar na rede (QR code ou texto). O nome é decidido pelo administrador. */
  async createInvite(name: string, role: Role = 'member'): Promise<{ code: string; expiresAt: number }> {
    const admin = this.needAdmin();
    const net = this.s.network!;
    const exp = this.now() + INVITE_TTL_MS;
    const token = b64.encode(randomBytes(16));
    admin.pendingInvites.push({ token, name: name.trim(), role, exp });
    const invite: Invite = { v: 1, net: net.net, authority: net.authority, name: net.name, adminBox: net.adminBox, adminInbox: net.adminInbox, relay: net.relay, token, exp };
    await this.persist();
    return { code: encodeCode('invite', invite), expiresAt: exp };
  }

  members(): MemberCert[] {
    return Object.values(this.needAdmin().members);
  }

  pendingInvites(): Array<{ name: string; exp: number }> {
    return this.needAdmin().pendingInvites.map((i) => ({ name: i.name, exp: i.exp }));
  }

  /** Retira a confiança numa pessoa. Vale na hora para quem receber o aviso, e para todos quando o certificado vencer. */
  async revokeMember(box: string): Promise<void> {
    const admin = this.needAdmin();
    if (box === this.myBox) throw new Error('O administrador não pode se revogar');
    const target = admin.members[box];
    if (!target) throw new Error('Membro desconhecido');
    const r = issueRevocation(this.authority!, box, this.now());
    this.s.revocations.push(r);
    delete admin.members[box];
    this.pruneContacts();
    await this.persist();
    await this.broadcastRoster({ revocations: [r] });
    await this.sendRosterTo({ box, relay: { url: target.relay, inbox: target.inbox } }, [], { revocations: [r] }).catch(() => undefined);
    await this.broadcastToPeerAdmins({ revocations: [r] });
  }

  /** Código público da rede, para outro administrador pedir conexão. */
  networkCode(): string {
    this.needAdmin();
    return encodeCode('network', this.descriptor());
  }

  private descriptor(): NetworkDescriptor {
    const n = this.s.network!;
    return issueDescriptor(this.authority!, { name: n.name, adminBox: n.adminBox, adminInbox: n.adminInbox, relay: n.relay });
  }

  /** Pedido de conexão: o outro administrador precisa aceitar. */
  async requestLink(peerNetworkCode: string): Promise<void> {
    const admin = this.needAdmin();
    const peer = decodeCode<NetworkDescriptor>('network', peerNetworkCode);
    if (!verifyDescriptor(peer).ok) throw new Error('Código de rede inválido');
    const mine = this.descriptor();
    const proposal = proposeLink(this.authority!, mine, peer, this.now());
    admin.outgoing = admin.outgoing.filter((o) => o.net !== peer.net);
    admin.outgoing.push({ net: peer.net, name: peer.name, at: this.now() });
    admin.peers[peer.net] = peer;
    await this.persist();
    await this.emit({ box: peer.adminBox, relay: { url: peer.relay, inbox: peer.adminInbox } }, PayloadType.LinkProposal, enc({ descriptor: mine, proposal } satisfies LinkProposalBody), { senderKey: true });
  }

  proposals(): Array<{ id: string; networkName: string; at: number }> {
    return this.needAdmin().proposals.map((p) => ({ id: p.id, networkName: p.descriptor.name, at: p.at }));
  }

  private async onLinkProposal(body: LinkProposalBody, sender: string, out: PollResult): Promise<void> {
    if (!this.isAdmin) return;
    const admin = this.s.admin!;
    const { descriptor, proposal } = body;
    if (!verifyDescriptor(descriptor).ok || descriptor.adminBox !== sender) return;
    if (!verifyPartialLink(proposal, b64.decode(descriptor.authority), this.now()).ok) return;
    if (proposal.a.net !== this.s.network!.net && proposal.b.net !== this.s.network!.net) return;
    admin.proposals = admin.proposals.filter((p) => p.descriptor.net !== descriptor.net);
    admin.proposals.push({ id: b64.encode(randomBytes(9)), descriptor, proposal, at: this.now() });
    out.events.push('proposal');
  }

  async acceptLink(proposalId: string): Promise<void> {
    const admin = this.needAdmin();
    const p = admin.proposals.find((x) => x.id === proposalId);
    if (!p) throw new Error('Pedido não encontrado');
    const link = countersignLink(this.authority!, p.proposal, this.now());
    admin.proposals = admin.proposals.filter((x) => x.id !== proposalId);
    admin.peers[p.descriptor.net] = p.descriptor;
    await this.adoptLink(link);
    await this.emit(
      { box: p.descriptor.adminBox, relay: { url: p.descriptor.relay, inbox: p.descriptor.adminInbox } },
      PayloadType.LinkAccepted,
      enc({ link, descriptor: this.descriptor() }),
      { senderKey: true },
    );
    await this.shareRosterWithPeer(p.descriptor);
  }

  async rejectLink(proposalId: string): Promise<void> {
    const admin = this.needAdmin();
    admin.proposals = admin.proposals.filter((x) => x.id !== proposalId);
    await this.persist();
  }

  private async onLinkAccepted(body: { link: LinkCert; descriptor: NetworkDescriptor }, sender: string, out: PollResult): Promise<void> {
    if (!this.isAdmin) return;
    const admin = this.s.admin!;
    const { link, descriptor } = body;
    if (!verifyDescriptor(descriptor).ok || descriptor.adminBox !== sender) return;
    const myNet = this.s.network!.net;
    const peer = otherParty(link, myNet);
    if (!peer || peer.net !== descriptor.net || !verifyLinkCert(link, this.now()).ok) return;
    if (!admin.outgoing.some((o) => o.net === peer.net)) return; // só aceita resposta a um pedido meu
    admin.outgoing = admin.outgoing.filter((o) => o.net !== peer.net);
    admin.peers[peer.net] = descriptor;
    await this.adoptLink(link);
    await this.shareRosterWithPeer(descriptor);
    out.events.push('link');
  }

  /** Guarda o vínculo e avisa os membros. */
  private async adoptLink(link: LinkCert): Promise<void> {
    const peer = otherParty(link, this.s.network!.net)!;
    this.s.links = [...this.s.links.filter((l) => otherParty(l, this.s.network!.net)?.net !== peer.net), link];
    this.s.unlinks = this.s.unlinks.filter((u) => !(u.peerNet === peer.net || u.net === peer.net));
    await this.persist();
    await this.broadcastRoster({ links: [link] });
  }

  /** Cada administrador entrega ao outro a lista (assinada) dos seus membros; cada um repassa aos seus. */
  private async shareRosterWithPeer(peer: NetworkDescriptor): Promise<void> {
    const admin = this.s.admin!;
    await this.sendRosterTo({ box: peer.adminBox, relay: { url: peer.relay, inbox: peer.adminInbox } }, Object.values(admin.members), { links: this.activeLinks() });
  }

  /** Encerra o vínculo com outra rede. */
  async unlink(peerNet: string): Promise<void> {
    const admin = this.needAdmin();
    const peer = admin.peers[peerNet];
    const r = issueLinkRevocation(this.authority!, peerNet, this.now());
    this.s.unlinks.push(r);
    this.s.links = this.s.links.filter((l) => otherParty(l, this.s.network!.net)?.net !== peerNet);
    this.pruneContacts();
    await this.persist();
    await this.broadcastRoster({ unlinks: [r] });
    if (peer) await this.sendRosterTo({ box: peer.adminBox, relay: { url: peer.relay, inbox: peer.adminInbox } }, [], { unlinks: [r] }).catch(() => undefined);
  }

  linkedNetworks(): Array<{ net: string; name: string; expiresAt: number }> {
    const me = this.s.network?.net ?? '';
    return this.activeLinks().map((l) => ({ net: otherParty(l, me)!.net, name: otherParty(l, me)!.name, expiresAt: l.exp }));
  }

  private foreignCerts(): MemberCert[] {
    return Object.values(this.s.contacts)
      .filter((c) => c.trust === 'linked')
      .map((c) => c.cert);
  }

  // ───────── lista de contatos (roster) ─────────

  private async sendRosterTo(addr: PeerAddress, certs: MemberCert[], extra: Partial<RosterUpdate> = {}): Promise<void> {
    const chunks: MemberCert[][] = [];
    for (let i = 0; i < certs.length; i += ROSTER_CHUNK) chunks.push(certs.slice(i, i + ROSTER_CHUNK));
    if (chunks.length === 0) chunks.push([]);
    for (let i = 0; i < chunks.length; i++) {
      await this.emit(addr, PayloadType.Roster, enc({ certs: chunks[i], ...(i === 0 ? extra : {}) } satisfies RosterUpdate));
    }
  }

  /** Atualização para todos os membros da minha rede (menos `except`). */
  private async broadcastRoster(update: RosterUpdate, except?: string): Promise<void> {
    if (!this.isAdmin) return;
    for (const m of Object.values(this.s.admin!.members)) {
      if (m.box === this.myBox || m.box === except) continue;
      await this.sendRosterTo({ box: m.box, relay: { url: m.relay, inbox: m.inbox } }, update.certs ?? [], { links: update.links, revocations: update.revocations, unlinks: update.unlinks }).catch(() => undefined);
    }
  }

  private async broadcastToPeerAdmins(update: RosterUpdate): Promise<void> {
    for (const p of Object.values(this.s.admin?.peers ?? {})) {
      if (!this.s.links.some((l) => otherParty(l, this.s.network!.net)?.net === p.net)) continue;
      await this.sendRosterTo({ box: p.adminBox, relay: { url: p.relay, inbox: p.adminInbox } }, update.certs ?? [], update).catch(() => undefined);
    }
  }

  /** Reenvia a lista completa para todos (por exemplo, depois de o relé ter ficado fora do ar). */
  async resyncRoster(): Promise<void> {
    const admin = this.needAdmin();
    for (const m of Object.values(admin.members)) {
      if (m.box === this.myBox) continue;
      await this.sendRosterTo({ box: m.box, relay: { url: m.relay, inbox: m.inbox } }, [...Object.values(admin.members), ...this.foreignCerts()], {
        links: this.activeLinks(),
        revocations: this.s.revocations,
        unlinks: this.s.unlinks,
      }).catch(() => undefined);
    }
  }

  /**
   * Aplica uma atualização de lista. Nada aqui depende de confiar em quem enviou: cada item se prova sozinho
   * (assinatura de uma autoridade em que confio, validade, vínculo ativo).
   */
  private async mergeRoster(u: RosterUpdate, out: PollResult): Promise<boolean> {
    const net = this.s.network;
    if (!net) return false;
    let fresh = false;
    const myAuthority = b64.decode(net.authority);

    for (const link of u.links ?? []) {
      const peer = otherParty(link, net.net);
      if (!peer || !verifyLinkCert(link, this.now()).ok) continue;
      if (this.s.links.some((l) => l.sigA === link.sigA && l.sigB === link.sigB)) continue;
      if (this.s.unlinks.some((x) => (x.peerNet === peer.net || x.net === peer.net) && x.iat >= link.iat)) continue;
      this.s.links = [...this.s.links.filter((l) => otherParty(l, net.net)?.net !== peer.net), link];
      fresh = true;
      out.events.push('link');
    }
    for (const un of u.unlinks ?? []) {
      // Só vale se envolve a minha rede, e é assinado pela autoridade de quem a emitiu.
      const mine = un.net === net.net;
      if (!mine && un.peerNet !== net.net) continue;
      const otherNet = mine ? un.peerNet : un.net;
      const authority = mine ? net.authority : this.s.links.map((l) => otherParty(l, net.net)).find((p) => p?.net === otherNet)?.authority;
      if (!authority || !verifyLinkRevocation(un, b64.decode(authority)).ok) continue;
      if (this.s.unlinks.some((x) => x.sig === un.sig)) continue;
      this.s.unlinks.push(un);
      this.s.links = this.s.links.filter((l) => otherParty(l, net.net)?.net !== otherNet || l.iat > un.iat);
      fresh = true;
      out.events.push('link');
    }
    for (const r of u.revocations ?? []) {
      const authority = r.net === net.net ? net.authority : this.activeLinks().map((l) => otherParty(l, net.net)).find((p) => p?.net === r.net)?.authority;
      if (!authority || !verifyRevocation(r, b64.decode(authority)).ok) continue;
      if (this.s.revocations.some((x) => x.sig === r.sig)) continue;
      this.s.revocations.push(r);
      if (this.s.me && r.target === this.s.me.box) {
        this.s.revoked = true;
        out.events.push('revoked');
      }
      fresh = true;
    }
    for (const cert of u.certs ?? []) {
      const r = this.addContact(cert);
      if (r === 'added' || r === 'updated') fresh = true;
    }
    this.pruneContacts();
    if (fresh) out.events.push('roster');
    return fresh;
  }

  private async onRoster(u: RosterUpdate, sender: string, out: PollResult): Promise<void> {
    // Administrador que recebe novidades de OUTRA rede as repassa aos seus membros (sem alterar nada: tudo é assinado).
    const fromPeerAdmin = this.isAdmin && Object.values(this.s.admin!.peers).some((p) => p.adminBox === sender);
    const before = new Set([...Object.keys(this.s.contacts)]);
    const revBefore = this.s.revocations.length;
    const linksBefore = this.s.links.length;
    const unBefore = this.s.unlinks.length;
    const fresh = await this.mergeRoster(u, out);
    if (fresh && fromPeerAdmin) {
      const newCerts = Object.values(this.s.contacts).filter((c) => !before.has(c.cert.box)).map((c) => c.cert);
      await this.broadcastRoster({
        certs: newCerts,
        revocations: this.s.revocations.slice(revBefore),
        links: this.s.links.slice(linksBefore),
        unlinks: this.s.unlinks.slice(unBefore),
      });
    }
  }
}

// ───────── Formatos de corpo (JSON dentro do quadro cifrado) ─────────

interface RosterUpdate {
  certs?: MemberCert[];
  links?: LinkCert[];
  revocations?: Revocation[];
  unlinks?: LinkRevocation[];
}

interface EnrollRequestBody {
  token: string;
  box: string;
  sign: string;
  inbox: string;
  relay: string;
  pop: string;
}

interface EnrollResponseBody extends RosterUpdate {
  cert: MemberCert;
}

interface LinkProposalBody {
  descriptor: NetworkDescriptor;
  proposal: PartialLink;
}
