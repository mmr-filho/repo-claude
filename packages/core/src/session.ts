import { ApiClient, ApiError, type ApiOptions } from './api';
import { b64, randomUuid } from './bytes';
import {
  DEFAULT_KDF_POLICY,
  DecryptError,
  WrongPasswordError,
  assertKdfParams,
  deriveAccountKeys,
  generateIdentity,
  newKdfSalt,
  openMessage,
  safetyNumber,
  sealMessage,
  unwrapSecretKey,
  wipeIdentity,
  wrapSecretKey,
  type Identity,
  type KdfParams,
  type KdfPolicy,
} from './crypto';
import { RealtimeClient, type WebSocketCtor } from './realtime';
import type { AuthBundle, Contact, ConversationSummary, MeResponse, ServerEvent, UserDTO } from './types';

export class LockedError extends Error {
  constructor() {
    super('O cofre está bloqueado. Digite a senha para ler as mensagens.');
    this.name = 'LockedError';
  }
}

export class KeyChangedError extends Error {
  constructor(
    public contact: Contact,
    public pinnedKey: string,
  ) {
    super(`A chave de segurança de ${contact.displayName} mudou. Confirme o número de segurança antes de continuar.`);
    this.name = 'KeyChangedError';
  }
}

/** Onde guardar a chave pública "vista pela primeira vez" de cada contato (confiança no primeiro uso). */
export interface KeyPinStore {
  get(userId: string): Promise<string | undefined>;
  set(userId: string, publicKey: string): Promise<void>;
}

export class MemoryPinStore implements KeyPinStore {
  private map = new Map<string, string>();
  async get(userId: string) {
    return this.map.get(userId);
  }
  async set(userId: string, publicKey: string) {
    this.map.set(userId, publicKey);
  }
}

export interface SessionOptions {
  baseUrl: string;
  fetch?: ApiOptions['fetch'];
  WebSocket?: WebSocketCtor;
  pinStore?: KeyPinStore;
  deviceName?: string;
  /** Substitui a política de parâmetros do KDF (usado em testes para scrypt barato). */
  kdfPolicy?: KdfPolicy;
  onUnauthorized?: () => void;
}

export interface ChatMessage {
  id: string;
  peerId: string;
  direction: 'in' | 'out';
  text: string;
  /** Hora de envio segundo o remetente. */
  sentAt: number;
  /** Hora em que o servidor recebeu. */
  createdAt: number;
}

export interface Conversation {
  messages: ChatMessage[];
  /** Mensagens que não puderam ser abertas (adulteradas, remetente desconhecido...). Continuam no servidor. */
  unreadable: string[];
}

/**
 * Sessão de um usuário no aparelho: guarda o token e, enquanto o cofre estiver aberto,
 * a chave privada em memória. Nada de texto de mensagem é gravado em disco ou fica em cache aqui.
 */
export class SigiloSession {
  readonly api: ApiClient;
  private identity?: Identity;
  private contactMap = new Map<string, Contact>();
  private realtime?: RealtimeClient;
  private pins: KeyPinStore;
  private policy: KdfPolicy;

  private constructor(
    private opts: SessionOptions,
    private info: Omit<MeResponse, 'expiresAt'> & { token: string },
  ) {
    this.api = new ApiClient({ baseUrl: opts.baseUrl, token: info.token, fetch: opts.fetch, onUnauthorized: opts.onUnauthorized });
    this.pins = opts.pinStore ?? new MemoryPinStore();
    this.policy = opts.kdfPolicy ?? DEFAULT_KDF_POLICY;
  }

  // ───────── criação ─────────

  /** Primeiro acesso: o administrador entrega o código de ativação e o usuário escolhe a senha. */
  static async activate(
    opts: SessionOptions & { handle: string; activationCode: string; password: string },
  ): Promise<SigiloSession> {
    const api = new ApiClient({ baseUrl: opts.baseUrl, fetch: opts.fetch });
    const policy = opts.kdfPolicy ?? DEFAULT_KDF_POLICY;
    const { kdfDefaults } = await api.serverInfo();
    const params: KdfParams = kdfDefaults;
    assertKdfParams(params, policy);

    const kdfSalt = newKdfSalt();
    const keys = await deriveAccountKeys(opts.password, kdfSalt, params, policy);
    const identity = generateIdentity();
    const bundle = await api.activate({
      handle: opts.handle,
      activationCode: opts.activationCode,
      kdfSalt,
      kdfParams: params,
      authSecret: keys.authSecret,
      publicKey: b64.encode(identity.publicKey),
      encryptedPrivateKey: wrapSecretKey(keys.kek, identity),
      deviceName: opts.deviceName,
    });
    const session = new SigiloSession(opts, bundle);
    session.identity = identity;
    return session;
  }

  static async login(opts: SessionOptions & { handle: string; password: string }): Promise<SigiloSession> {
    const api = new ApiClient({ baseUrl: opts.baseUrl, fetch: opts.fetch });
    const policy = opts.kdfPolicy ?? DEFAULT_KDF_POLICY;
    const pre = await api.prelogin(opts.handle);
    const keys = await deriveAccountKeys(opts.password, pre.kdfSalt, pre.kdfParams, policy);
    const bundle = await api.login({ handle: opts.handle, authSecret: keys.authSecret, deviceName: opts.deviceName });
    const session = new SigiloSession(opts, bundle);
    try {
      session.identity = unwrapSecretKey(keys.kek, bundle.publicKey, bundle.encryptedPrivateKey);
    } catch (err) {
      // Servidor devolveu um cofre que a senha não abre: não mantém sessão aberta à toa.
      await api.logout().catch(() => {});
      throw err;
    }
    return session;
  }

  /** Reabre o app com um token guardado: sessão ativa, cofre bloqueado até digitar a senha. */
  static async resume(opts: SessionOptions & { token: string }): Promise<SigiloSession> {
    const api = new ApiClient({ baseUrl: opts.baseUrl, token: opts.token, fetch: opts.fetch, onUnauthorized: opts.onUnauthorized });
    const me = await api.me();
    return new SigiloSession(opts, { ...me, token: opts.token });
  }

  // ───────── estado ─────────

  get user(): UserDTO {
    return this.info.user;
  }
  get token(): string {
    return this.info.token;
  }
  get publicKey(): string {
    return this.info.publicKey;
  }
  get isUnlocked(): boolean {
    return !!this.identity;
  }
  get isAdmin(): boolean {
    return this.info.user.role === 'admin';
  }

  private requireIdentity(): Identity {
    if (!this.identity) throw new LockedError();
    return this.identity;
  }

  /** Digite a senha para abrir o cofre. Lança WrongPasswordError se estiver errada. */
  async unlock(password: string): Promise<void> {
    if (this.identity) return;
    assertKdfParams(this.info.kdfParams, this.policy);
    const keys = await deriveAccountKeys(password, this.info.kdfSalt, this.info.kdfParams, this.policy);
    this.identity = unwrapSecretKey(keys.kek, this.info.publicKey, this.info.encryptedPrivateKey);
  }

  /** Apaga a chave privada da memória. As mensagens ficam ilegíveis até nova senha. */
  lock(): void {
    if (this.identity) wipeIdentity(this.identity);
    this.identity = undefined;
    this.contactMap.clear();
  }

  async logout(): Promise<void> {
    this.stopRealtime();
    this.lock();
    await this.api.logout().catch(() => {});
  }

  async changePassword(current: string, next: string): Promise<void> {
    const identity = this.requireIdentity();
    const currentKeys = await deriveAccountKeys(current, this.info.kdfSalt, this.info.kdfParams, this.policy);
    // Confirma a senha atual localmente antes de mexer no servidor.
    unwrapSecretKey(currentKeys.kek, this.info.publicKey, this.info.encryptedPrivateKey);
    const { kdfDefaults } = await this.api.serverInfo();
    assertKdfParams(kdfDefaults, this.policy);
    const salt = newKdfSalt();
    const nextKeys = await deriveAccountKeys(next, salt, kdfDefaults, this.policy);
    const wrapped = wrapSecretKey(nextKeys.kek, identity);
    await this.api.changePassword({
      currentAuthSecret: currentKeys.authSecret,
      newAuthSecret: nextKeys.authSecret,
      newKdfSalt: salt,
      newKdfParams: kdfDefaults,
      newEncryptedPrivateKey: wrapped,
    });
    this.info = { ...this.info, kdfSalt: salt, kdfParams: kdfDefaults, encryptedPrivateKey: wrapped };
  }

  // ───────── tempo real ─────────

  startRealtime(onEvent: (e: ServerEvent) => void, onStatus?: (s: 'up' | 'down') => void): void {
    this.stopRealtime();
    this.realtime = new RealtimeClient({
      baseUrl: this.opts.baseUrl,
      token: this.info.token,
      WebSocket: this.opts.WebSocket,
      onEvent,
      onStatus,
    });
    this.realtime.start();
  }

  stopRealtime(): void {
    this.realtime?.stop();
    this.realtime = undefined;
  }

  // ───────── contatos e chaves ─────────

  async loadContacts(): Promise<Contact[]> {
    const list = await this.api.contacts();
    this.contactMap = new Map(list.map((c) => [c.id, c]));
    return list;
  }

  /**
   * Sempre consulta o servidor: cifrar com uma chave desatualizada (contato que refez a conta)
   * geraria uma mensagem que ele não consegue abrir.
   */
  private async contactFor(peerId: string): Promise<Contact> {
    const contact = await this.api.contact(peerId);
    this.contactMap.set(contact.id, contact);
    return contact;
  }

  /** Confiança no primeiro uso: fixa a chave vista na primeira vez e barra se ela mudar. */
  private async checkPin(contact: Contact): Promise<void> {
    const pinned = await this.pins.get(contact.id);
    if (!pinned) await this.pins.set(contact.id, contact.publicKey);
    else if (pinned !== contact.publicKey) throw new KeyChangedError(contact, pinned);
  }

  /** O usuário conferiu o número de segurança e aceita a nova chave do contato. */
  async trustKey(contactId: string): Promise<void> {
    const contact = await this.contactFor(contactId);
    await this.pins.set(contact.id, contact.publicKey);
  }

  safetyNumberWith(contact: Contact): string {
    return safetyNumber(b64.decode(this.info.publicKey), b64.decode(contact.publicKey));
  }

  // ───────── mensagens ─────────

  async send(peerId: string, text: string): Promise<ChatMessage> {
    const me = this.requireIdentity();
    const body = text.trim();
    if (!body) throw new Error('Mensagem vazia');
    const contact = await this.contactFor(peerId);
    await this.checkPin(contact);

    const payload = { text: body, sentAt: Date.now() };
    const ctx = { messageId: randomUuid(), senderId: this.info.user.id, recipientId: contact.id };
    const envelope = sealMessage({ payload, ctx, role: 'recipient', author: me, targetPublicKey: b64.decode(contact.publicKey) });
    const senderEnvelope = sealMessage({ payload, ctx, role: 'sender', author: me, targetPublicKey: me.publicKey });
    const sent = await this.api.sendMessage({ id: ctx.messageId, recipientId: contact.id, envelope, senderEnvelope });
    return { id: ctx.messageId, peerId: contact.id, direction: 'out', text: body, sentAt: payload.sentAt, createdAt: sent.createdAt };
  }

  /**
   * Abre a conversa: baixa e descriptografa o que o contato mandou e o que eu enviei e ainda não foi lido.
   * Com `markAsRead` (padrão), as mensagens recebidas são apagadas do servidor logo após descriptografar:
   * a partir daqui elas só existem na memória do aparelho.
   */
  async openConversation(peerId: string, opts: { markAsRead?: boolean } = {}): Promise<Conversation> {
    const me = this.requireIdentity();
    const contact = await this.contactFor(peerId);
    await this.checkPin(contact);
    const peerKey = b64.decode(contact.publicKey);

    const [inbox, outbox] = await Promise.all([this.api.inbox(peerId), this.api.outbox(peerId)]);
    const messages: ChatMessage[] = [];
    const unreadable: string[] = [];
    const readable: string[] = [];

    for (const item of inbox) {
      try {
        const p = openMessage({
          envelope: item.envelope,
          ctx: { messageId: item.id, senderId: item.senderId, recipientId: this.info.user.id },
          role: 'recipient',
          self: me,
          authorPublicKey: peerKey,
        });
        messages.push({ id: item.id, peerId, direction: 'in', text: p.text, sentAt: p.sentAt, createdAt: item.createdAt });
        readable.push(item.id);
      } catch (err) {
        if (!(err instanceof DecryptError)) throw err;
        unreadable.push(item.id);
      }
    }
    for (const item of outbox) {
      try {
        const p = openMessage({
          envelope: item.senderEnvelope,
          ctx: { messageId: item.id, senderId: this.info.user.id, recipientId: item.recipientId },
          role: 'sender',
          self: me,
          authorPublicKey: me.publicKey,
        });
        messages.push({ id: item.id, peerId, direction: 'out', text: p.text, sentAt: p.sentAt, createdAt: item.createdAt });
      } catch (err) {
        if (!(err instanceof DecryptError)) throw err;
        unreadable.push(item.id);
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt);

    if (opts.markAsRead !== false && readable.length) await this.api.markRead(readable);
    return { messages, unreadable };
  }

  /** Apaga do servidor mensagens recebidas que não puderam ser abertas. */
  async discard(ids: string[]): Promise<void> {
    if (ids.length) await this.api.markRead(ids);
  }

  /** "Apagar para todos": só funciona enquanto o destinatário não leu. */
  recall(id: string): Promise<void> {
    return this.api.recall(id);
  }

  summary(): Promise<ConversationSummary[]> {
    return this.api.summary();
  }
}

export type { AuthBundle };
export { WrongPasswordError };
