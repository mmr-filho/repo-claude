import { b64, utf8Decode, utf8Encode, type Bytes } from '../bytes';
import type { Role } from '../types';
import { networkIdOf, sign, verify, type SignKeys } from './keys';

/*
 * Certificados do Sigilo v2. Não existe servidor de contas: quem decide quem faz parte de uma rede é a
 * AUTORIDADE da rede (a chave de assinatura que fica no aparelho do administrador). Cada aparelho confere
 * as assinaturas sozinho.
 *
 *   MemberCert   a autoridade afirma "esta chave pertence a esta pessoa nesta rede" (com validade)
 *   LinkCert     as autoridades de DUAS redes assinam que as redes podem conversar (com validade)
 *   Revocation   a autoridade retira a confiança numa chave antes do vencimento
 *
 * Regra de ouro: só se aceita mensagem de quem apresenta um MemberCert válido de uma rede em que SE CONFIA
 * (a própria, ou uma com LinkCert válido). Vínculos não são transitivos.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MEMBER_CERT_TTL_MS = 30 * DAY_MS;
export const LINK_CERT_TTL_MS = 90 * DAY_MS;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface MemberCert {
  v: 1;
  /** Id da rede (hash da chave da autoridade). */
  net: string;
  /** Chave pública da autoridade que assinou (base64url). */
  authority: string;
  /** Chave de cifra X25519 da pessoa. */
  box: string;
  /** Chave de assinatura Ed25519 da pessoa. */
  sign: string;
  name: string;
  role: Role;
  /** Caixa postal (id da fila) no relé. */
  inbox: string;
  /** Endereço do relé onde a caixa postal está. */
  relay: string;
  iat: number;
  exp: number;
  sig: string;
}

export interface NetworkDescriptor {
  v: 1;
  net: string;
  authority: string;
  name: string;
  /** Chave de cifra e caixa postal do administrador (para receber pedidos de vínculo e de entrada). */
  adminBox: string;
  adminInbox: string;
  relay: string;
  sig: string;
}

export interface LinkParty {
  net: string;
  authority: string;
  name: string;
}

export interface LinkCert {
  v: 1;
  /** As duas partes, em ordem de id (a < b), para o texto assinado ser único. */
  a: LinkParty;
  b: LinkParty;
  iat: number;
  exp: number;
  sigA: string;
  sigB: string;
}

export interface Revocation {
  v: 1;
  net: string;
  authority: string;
  /** Chave de cifra (box) cuja confiança foi retirada. */
  target: string;
  iat: number;
  sig: string;
}

export interface Invite {
  v: 1;
  net: string;
  authority: string;
  name: string;
  adminBox: string;
  adminInbox: string;
  relay: string;
  /** Segredo de uso único que autoriza um pedido de entrada. */
  token: string;
  exp: number;
}

export type Verdict = { ok: true } | { ok: false; reason: string };
const ok: Verdict = { ok: true };
const bad = (reason: string): Verdict => ({ ok: false, reason });

/** Texto que é de fato assinado: domínio + campos em ordem fixa. Nomes viram base64url para não conter separadores. */
function tbs(domain: string, fields: Array<string | number>): Bytes {
  for (const f of fields) if (typeof f === 'string' && f.includes('\n')) throw new Error('campo com quebra de linha');
  return utf8Encode(`sigilo/v2/${domain}\n${fields.join('\n')}`);
}

const nameField = (name: string) => b64.encode(utf8Encode(name));

// ───────── MemberCert ─────────

function memberTbs(c: Omit<MemberCert, 'sig'>): Bytes {
  return tbs('member', [c.v, c.net, c.authority, c.box, c.sign, nameField(c.name), c.role, c.inbox, c.relay, c.iat, c.exp]);
}

export function issueMemberCert(
  authority: SignKeys,
  fields: Pick<MemberCert, 'box' | 'sign' | 'name' | 'role' | 'inbox' | 'relay'>,
  now = Date.now(),
  ttlMs = MEMBER_CERT_TTL_MS,
): MemberCert {
  const body: Omit<MemberCert, 'sig'> = {
    v: 1,
    net: networkIdOf(authority.publicKey),
    authority: b64.encode(authority.publicKey),
    ...fields,
    iat: now,
    exp: now + ttlMs,
  };
  return { ...body, sig: b64.encode(sign(authority.secretKey, memberTbs(body))) };
}

/** Confere assinatura, rede, validade e a autoridade esperada. Não confere revogação (isso é do TrustStore). */
export function verifyMemberCert(cert: MemberCert, trustedAuthority: Bytes, now = Date.now()): Verdict {
  try {
    if (cert.v !== 1) return bad('versão desconhecida');
    if (cert.authority !== b64.encode(trustedAuthority)) return bad('autoridade não é a esperada');
    if (cert.net !== networkIdOf(trustedAuthority)) return bad('id da rede não confere');
    if (!verify(trustedAuthority, memberTbs(cert), b64.decode(cert.sig))) return bad('assinatura inválida');
    if (cert.iat > now + CLOCK_SKEW_MS) return bad('certificado do futuro');
    if (cert.exp <= now) return bad('certificado vencido');
    return ok;
  } catch {
    return bad('certificado malformado');
  }
}

// ───────── NetworkDescriptor ─────────

function descriptorTbs(d: Omit<NetworkDescriptor, 'sig'>): Bytes {
  return tbs('network', [d.v, d.net, d.authority, nameField(d.name), d.adminBox, d.adminInbox, d.relay]);
}

export function issueDescriptor(authority: SignKeys, fields: Pick<NetworkDescriptor, 'name' | 'adminBox' | 'adminInbox' | 'relay'>): NetworkDescriptor {
  const body: Omit<NetworkDescriptor, 'sig'> = {
    v: 1,
    net: networkIdOf(authority.publicKey),
    authority: b64.encode(authority.publicKey),
    ...fields,
  };
  return { ...body, sig: b64.encode(sign(authority.secretKey, descriptorTbs(body))) };
}

export function verifyDescriptor(d: NetworkDescriptor): Verdict {
  try {
    const pub = b64.decode(d.authority);
    if (d.v !== 1 || d.net !== networkIdOf(pub)) return bad('id da rede não confere');
    return verify(pub, descriptorTbs(d), b64.decode(d.sig)) ? ok : bad('assinatura inválida');
  } catch {
    return bad('descritor malformado');
  }
}

// ───────── LinkCert ─────────

const partyOf = (d: { net: string; authority: string; name: string }): LinkParty => ({ net: d.net, authority: d.authority, name: d.name });

function linkTbs(c: Pick<LinkCert, 'v' | 'a' | 'b' | 'iat' | 'exp'>): Bytes {
  return tbs('link', [c.v, c.a.net, c.a.authority, nameField(c.a.name), c.b.net, c.b.authority, nameField(c.b.name), c.iat, c.exp]);
}

export type PartialLink = Omit<LinkCert, 'sigA' | 'sigB'> & { sigA?: string; sigB?: string };

/** A autoridade `mine` propõe o vínculo com a rede descrita por `peer`. Falta a assinatura da outra. */
export function proposeLink(mine: SignKeys, myDesc: { net: string; authority: string; name: string }, peer: NetworkDescriptor, now = Date.now(), ttlMs = LINK_CERT_TTL_MS): PartialLink {
  const me = partyOf(myDesc);
  const other = partyOf(peer);
  if (me.net === other.net) throw new Error('uma rede não se vincula a ela mesma');
  const [a, b] = me.net < other.net ? [me, other] : [other, me];
  const body = { v: 1 as const, a, b, iat: now, exp: now + ttlMs };
  const sig = b64.encode(sign(mine.secretKey, linkTbs(body)));
  return me.net === a.net ? { ...body, sigA: sig } : { ...body, sigB: sig };
}

/** A outra autoridade confere a proposta e a completa com a sua assinatura. */
export function countersignLink(mine: SignKeys, proposal: PartialLink, now = Date.now()): LinkCert {
  const myNet = networkIdOf(mine.publicKey);
  const iAmA = proposal.a.net === myNet;
  if (!iAmA && proposal.b.net !== myNet) throw new Error('a proposta não é para esta rede');
  const body = { v: proposal.v, a: proposal.a, b: proposal.b, iat: proposal.iat, exp: proposal.exp };
  if (proposal.exp <= now) throw new Error('proposta vencida');
  const sig = b64.encode(sign(mine.secretKey, linkTbs(body)));
  const full = { ...body, sigA: iAmA ? sig : proposal.sigA ?? '', sigB: iAmA ? proposal.sigB ?? '' : sig };
  const check = verifyLinkCert(full, now);
  if (!check.ok) throw new Error(`proposta inválida: ${check.reason}`);
  return full;
}

export function verifyLinkCert(c: LinkCert, now = Date.now()): Verdict {
  try {
    if (c.v !== 1 || !(c.a.net < c.b.net)) return bad('formato inválido');
    const pa = b64.decode(c.a.authority);
    const pb = b64.decode(c.b.authority);
    if (c.a.net !== networkIdOf(pa) || c.b.net !== networkIdOf(pb)) return bad('id da rede não confere');
    const text = linkTbs(c);
    if (!verify(pa, text, b64.decode(c.sigA)) || !verify(pb, text, b64.decode(c.sigB))) return bad('assinatura inválida');
    if (c.exp <= now) return bad('vínculo vencido');
    if (c.iat > now + CLOCK_SKEW_MS) return bad('vínculo do futuro');
    return ok;
  } catch {
    return bad('vínculo malformado');
  }
}

/** A parte do vínculo que NÃO é a rede `myNet`. */
export function otherParty(c: LinkCert, myNet: string): LinkParty | undefined {
  return c.a.net === myNet ? c.b : c.b.net === myNet ? c.a : undefined;
}

/** Confere a única assinatura presente numa proposta ainda incompleta. */
export function verifyPartialLink(p: PartialLink, proposerAuthority: Bytes, now = Date.now()): Verdict {
  try {
    const proposerNet = networkIdOf(proposerAuthority);
    const sig = p.a.net === proposerNet ? p.sigA : p.b.net === proposerNet ? p.sigB : undefined;
    if (!sig) return bad('o proponente não faz parte do vínculo');
    const side = p.a.net === proposerNet ? p.a : p.b;
    if (side.authority !== b64.encode(proposerAuthority)) return bad('autoridade não confere');
    if (!(p.a.net < p.b.net)) return bad('formato inválido');
    if (!verify(proposerAuthority, linkTbs(p), b64.decode(sig))) return bad('assinatura inválida');
    return p.exp > now ? ok : bad('proposta vencida');
  } catch {
    return bad('proposta malformada');
  }
}

/** Qualquer uma das duas autoridades pode encerrar um vínculo antes do vencimento. */
export interface LinkRevocation {
  v: 1;
  net: string;
  authority: string;
  peerNet: string;
  iat: number;
  sig: string;
}

function linkRevocationTbs(r: Omit<LinkRevocation, 'sig'>): Bytes {
  return tbs('unlink', [r.v, r.net, r.authority, r.peerNet, r.iat]);
}

export function issueLinkRevocation(authority: SignKeys, peerNet: string, now = Date.now()): LinkRevocation {
  const body: Omit<LinkRevocation, 'sig'> = { v: 1, net: networkIdOf(authority.publicKey), authority: b64.encode(authority.publicKey), peerNet, iat: now };
  return { ...body, sig: b64.encode(sign(authority.secretKey, linkRevocationTbs(body))) };
}

export function verifyLinkRevocation(r: LinkRevocation, trustedAuthority: Bytes): Verdict {
  try {
    if (r.authority !== b64.encode(trustedAuthority) || r.net !== networkIdOf(trustedAuthority)) return bad('autoridade não é a esperada');
    return verify(trustedAuthority, linkRevocationTbs(r), b64.decode(r.sig)) ? ok : bad('assinatura inválida');
  } catch {
    return bad('revogação malformada');
  }
}

// ───────── Revocation ─────────

function revocationTbs(r: Omit<Revocation, 'sig'>): Bytes {
  return tbs('revoke', [r.v, r.net, r.authority, r.target, r.iat]);
}

export function issueRevocation(authority: SignKeys, targetBox: string, now = Date.now()): Revocation {
  const body: Omit<Revocation, 'sig'> = {
    v: 1,
    net: networkIdOf(authority.publicKey),
    authority: b64.encode(authority.publicKey),
    target: targetBox,
    iat: now,
  };
  return { ...body, sig: b64.encode(sign(authority.secretKey, revocationTbs(body))) };
}

export function verifyRevocation(r: Revocation, trustedAuthority: Bytes): Verdict {
  try {
    if (r.authority !== b64.encode(trustedAuthority)) return bad('autoridade não é a esperada');
    return verify(trustedAuthority, revocationTbs(r), b64.decode(r.sig)) ? ok : bad('assinatura inválida');
  } catch {
    return bad('revogação malformada');
  }
}

// ───────── Códigos para QR / texto ─────────

const PREFIX = { invite: 'sigilo2-convite:', network: 'sigilo2-rede:', link: 'sigilo2-vinculo:' } as const;

export function encodeCode(kind: keyof typeof PREFIX, value: unknown): string {
  return PREFIX[kind] + b64.encode(utf8Encode(JSON.stringify(value)));
}

export function decodeCode<T>(kind: keyof typeof PREFIX, code: string): T {
  const text = code.trim();
  if (!text.startsWith(PREFIX[kind])) throw new Error('código de tipo errado');
  const raw = b64.decode(text.slice(PREFIX[kind].length));
  return JSON.parse(utf8Decode(raw)) as T;
}
