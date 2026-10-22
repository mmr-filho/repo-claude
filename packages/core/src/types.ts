import type { KdfParams } from './crypto';

export type Role = 'admin' | 'member';
export type UserStatus = 'pending' | 'active' | 'disabled';

export interface UserDTO {
  id: string;
  /** Identificador de login e de contato: usuario@rede */
  handle: string;
  username: string;
  displayName: string;
  role: Role;
  networkId: string;
  networkSlug: string;
  networkName: string;
}

/** Tudo que o aparelho precisa para entrar e desbloquear o cofre. */
export interface AuthBundle {
  token: string;
  expiresAt: number;
  user: UserDTO;
  publicKey: string;
  encryptedPrivateKey: string;
  kdfSalt: string;
  kdfParams: KdfParams;
}

/** Resposta de GET /me: o mesmo que o login, sem token novo. */
export type MeResponse = Omit<AuthBundle, 'token'>;

export interface ServerInfo {
  name: string;
  version: string;
  /** Parâmetros de scrypt recomendados para contas novas neste servidor. */
  kdfDefaults: KdfParams;
}

export interface PreloginResponse {
  kdfSalt: string;
  kdfParams: KdfParams;
}

export interface ActivateRequest {
  handle: string;
  activationCode: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  authSecret: string;
  publicKey: string;
  encryptedPrivateKey: string;
  deviceName?: string;
}

export interface LoginRequest {
  handle: string;
  authSecret: string;
  deviceName?: string;
}

export interface ChangePasswordRequest {
  currentAuthSecret: string;
  newAuthSecret: string;
  newKdfSalt: string;
  newKdfParams: KdfParams;
  newEncryptedPrivateKey: string;
}

export interface Contact {
  id: string;
  handle: string;
  displayName: string;
  role: Role;
  networkSlug: string;
  networkName: string;
  sameNetwork: boolean;
  publicKey: string;
}

export interface SendMessageRequest {
  /** UUID gerado no aparelho: faz parte dos dados autenticados da cifragem. */
  id: string;
  recipientId: string;
  /** Cópia cifrada para o destinatário. */
  envelope: string;
  /** Cópia cifrada para o próprio remetente (relê até o destinatário ler). */
  senderEnvelope: string;
}

export interface InboxItem {
  id: string;
  senderId: string;
  createdAt: number;
  envelope: string;
}

export interface OutboxItem {
  id: string;
  recipientId: string;
  createdAt: number;
  senderEnvelope: string;
}

/** Metadados por conversa: nunca inclui conteúdo. */
export interface ConversationSummary {
  peerId: string;
  /** Mensagens recebidas ainda não lidas (bloqueadas). */
  incoming: number;
  /** Mensagens enviadas que o outro lado ainda não leu. */
  outgoing: number;
  lastAt: number;
}

// ───────── Administração ─────────

export interface MemberDTO {
  id: string;
  username: string;
  handle: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: number;
}

export interface CreateMemberRequest {
  username: string;
  displayName: string;
  role?: Role;
}

export interface MemberWithCode {
  member: MemberDTO;
  /** Mostrado uma única vez. O administrador entrega ao usuário. */
  activationCode: string;
  activationExpiresAt: number;
}

export type LinkStatus = 'pending' | 'active';

export interface LinkDTO {
  id: string;
  peerSlug: string;
  peerName: string;
  status: LinkStatus;
  /** 'incoming' = a outra rede pediu e este admin precisa responder. */
  direction: 'incoming' | 'outgoing' | 'mutual';
  createdAt: number;
}

export interface LinksOverview {
  active: LinkDTO[];
  incoming: LinkDTO[];
  outgoing: LinkDTO[];
}

export interface InviteDTO {
  code: string;
  expiresAt: number;
}

// ───────── Tempo real (WebSocket) ─────────

export type ServerEvent =
  | { type: 'ready' }
  | { type: 'message.new'; id: string; senderId: string; createdAt: number }
  | { type: 'message.read'; ids: string[]; readerId: string }
  | { type: 'message.recalled'; id: string; senderId: string }
  | { type: 'contacts.changed' }
  | { type: 'session.revoked' };

export interface ApiErrorBody {
  error: string;
  message: string;
}
