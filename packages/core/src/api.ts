import type {
  ActivateRequest,
  AuthBundle,
  ChangePasswordRequest,
  Contact,
  ConversationSummary,
  CreateMemberRequest,
  InboxItem,
  InviteDTO,
  LinksOverview,
  LoginRequest,
  MeResponse,
  MemberDTO,
  MemberWithCode,
  OutboxItem,
  PreloginResponse,
  SendMessageRequest,
  ServerInfo,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  token?: string;
  /** Chamado quando o servidor recusa o token (sessão expirada/revogada). */
  onUnauthorized?: () => void;
}

export class ApiClient {
  readonly baseUrl: string;
  token?: string;
  private fetchImpl: typeof fetch;
  private onUnauthorized?: () => void;

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.onUnauthorized = opts.onUnauthorized;
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'network', 'Sem conexão com o servidor');
    }
    if (res.status === 204) return undefined as T;
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const err = (data ?? {}) as { error?: string; message?: string };
      const apiErr = new ApiError(res.status, err.error ?? 'error', err.message ?? `Erro ${res.status}`);
      if (res.status === 401 && auth && this.token) this.onUnauthorized?.();
      throw apiErr;
    }
    return data as T;
  }

  private get = <T>(path: string) => this.request<T>('GET', path);
  private post = <T>(path: string, body?: unknown) => this.request<T>('POST', path, body ?? {});

  // ── públicas ──
  serverInfo = () => this.request<ServerInfo>('GET', '/server-info', undefined, false);
  prelogin = (handle: string) => this.request<PreloginResponse>('POST', '/auth/prelogin', { handle }, false);
  activate = (req: ActivateRequest) => this.request<AuthBundle>('POST', '/auth/activate', req, false);
  login = (req: LoginRequest) => this.request<AuthBundle>('POST', '/auth/login', req, false);

  // ── sessão ──
  logout = () => this.request<void>('POST', '/auth/logout', {});
  me = () => this.get<MeResponse>('/me');
  changePassword = (req: ChangePasswordRequest) => this.request<void>('POST', '/auth/change-password', req);
  contacts = () => this.get<Contact[]>('/contacts');
  contact = (id: string) => this.get<Contact>(`/contacts/${id}`);

  // ── mensagens ──
  sendMessage = (req: SendMessageRequest) => this.post<{ id: string; createdAt: number }>('/messages', req);
  inbox = (from?: string) => this.get<InboxItem[]>(`/messages/inbox${from ? `?from=${from}` : ''}`);
  outbox = (to?: string) => this.get<OutboxItem[]>(`/messages/outbox${to ? `?to=${to}` : ''}`);
  summary = () => this.get<ConversationSummary[]>('/messages/summary');
  markRead = (ids: string[]) => this.post<{ deleted: number }>('/messages/read', { ids });
  recall = (id: string) => this.request<void>('DELETE', `/messages/${id}`);

  // ── administração ──
  members = () => this.get<MemberDTO[]>('/admin/members');
  createMember = (req: CreateMemberRequest) => this.post<MemberWithCode>('/admin/members', req);
  resetActivation = (id: string) => this.post<MemberWithCode>(`/admin/members/${id}/reset-activation`);
  disableMember = (id: string) => this.post<MemberDTO>(`/admin/members/${id}/disable`);
  enableMember = (id: string) => this.post<MemberDTO>(`/admin/members/${id}/enable`);

  links = () => this.get<LinksOverview>('/admin/links');
  requestLink = (slug: string) => this.post<{ ok: true }>('/admin/links/requests', { slug });
  acceptLink = (id: string) => this.post<{ ok: true }>(`/admin/links/${id}/accept`);
  rejectLink = (id: string) => this.post<{ ok: true }>(`/admin/links/${id}/reject`);
  cancelLink = (id: string) => this.post<{ ok: true }>(`/admin/links/${id}/cancel`);
  revokeLink = (id: string) => this.post<{ ok: true }>(`/admin/links/${id}/revoke`);
  createInvite = () => this.post<InviteDTO>('/admin/links/invites');
  acceptInvite = (code: string) => this.post<{ ok: true }>('/admin/links/invites/accept', { code });
}
