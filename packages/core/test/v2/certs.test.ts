import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64 } from '../../src/bytes';
import {
  DAY_MS,
  countersignLink,
  decodeCode,
  encodeCode,
  issueDescriptor,
  issueMemberCert,
  issueRevocation,
  otherParty,
  proposeLink,
  verifyDescriptor,
  verifyLinkCert,
  verifyMemberCert,
  verifyRevocation,
  type MemberCert,
} from '../../src/v2/certs';
import { generateIdentity2, generateSignKeys, networkIdOf } from '../../src/v2/keys';

function member(authority = generateSignKeys(), over: Partial<MemberCert> = {}) {
  const id = generateIdentity2();
  const cert = issueMemberCert(authority, {
    box: b64.encode(id.box.publicKey),
    sign: b64.encode(id.sign.publicKey),
    name: 'Ana Souza',
    role: 'member',
    inbox: 'inbox-ana',
    relay: 'https://relay.example',
    ...over,
  });
  return { authority, id, cert };
}

test('certificado de membro: válido para a autoridade certa, recusa outra', () => {
  const { authority, cert } = member();
  assert.deepEqual(verifyMemberCert(cert, authority.publicKey), { ok: true });
  assert.equal(cert.net, networkIdOf(authority.publicKey));
  const outsider = generateSignKeys();
  assert.equal(verifyMemberCert(cert, outsider.publicKey).ok, false);
});

test('certificado de membro: qualquer campo alterado invalida a assinatura', () => {
  const { authority, cert } = member();
  const tampered: Array<Partial<MemberCert>> = [
    { name: 'Outra Pessoa' },
    { role: 'admin' },
    { box: b64.encode(generateIdentity2().box.publicKey) },
    { sign: b64.encode(generateIdentity2().sign.publicKey) },
    { inbox: 'inbox-do-atacante' },
    { relay: 'https://atacante.example' },
    { exp: cert.exp + 365 * DAY_MS },
  ];
  for (const change of tampered) {
    const verdict = verifyMemberCert({ ...cert, ...change }, authority.publicKey);
    assert.equal(verdict.ok, false, JSON.stringify(change).slice(0, 60));
  }
});

test('certificado de membro: vence e não vale antes da hora', () => {
  const { authority, cert } = member();
  assert.equal(verifyMemberCert(cert, authority.publicKey, cert.exp + 1).ok, false);
  assert.equal(verifyMemberCert(cert, authority.publicKey, cert.exp - 1).ok, true);
  assert.equal(verifyMemberCert(cert, authority.publicKey, cert.iat - 10 * 60 * 1000).ok, false);
});

test('um nome com quebra de linha ou separador não consegue forjar outro campo assinado', () => {
  const { authority, cert } = member(generateSignKeys(), { name: 'Ana\nadmin' });
  assert.equal(verifyMemberCert(cert, authority.publicKey).ok, true);
  assert.equal(cert.role, 'member');
  assert.equal(verifyMemberCert({ ...cert, name: 'Ana' }, authority.publicKey).ok, false);
});

test('descritor da rede é autoassinado', () => {
  const authority = generateSignKeys();
  const admin = generateIdentity2();
  const d = issueDescriptor(authority, { name: 'UniRG', adminBox: b64.encode(admin.box.publicKey), adminInbox: 'q-admin', relay: 'https://relay.example' });
  assert.deepEqual(verifyDescriptor(d), { ok: true });
  assert.equal(verifyDescriptor({ ...d, adminInbox: 'q-atacante' }).ok, false);
  assert.equal(verifyDescriptor({ ...d, authority: b64.encode(generateSignKeys().publicKey) }).ok, false);
});

test('vínculo entre redes: exige as DUAS assinaturas e não é transitivo', () => {
  const ka = generateSignKeys();
  const kb = generateSignKeys();
  const kc = generateSignKeys();
  const adm = generateIdentity2();
  const mk = (k: typeof ka, name: string) =>
    issueDescriptor(k, { name, adminBox: b64.encode(adm.box.publicKey), adminInbox: `q-${name}`, relay: 'https://r' });
  const da = mk(ka, 'A');
  const db = mk(kb, 'B');
  const dc = mk(kc, 'C');

  const proposal = proposeLink(ka, da, db);
  // Só com uma assinatura não vale.
  assert.equal(verifyLinkCert({ ...proposal, sigA: proposal.sigA ?? '', sigB: proposal.sigB ?? '' }).ok, false);
  const link = countersignLink(kb, proposal);
  assert.deepEqual(verifyLinkCert(link), { ok: true });
  assert.equal(otherParty(link, da.net)?.net, db.net);
  assert.equal(otherParty(link, db.net)?.net, da.net);
  assert.equal(otherParty(link, dc.net), undefined, 'C não faz parte do vínculo A–B');

  // Quem não é parte não consegue contra-assinar.
  assert.throws(() => countersignLink(kc, proposal), /não é para esta rede/);
  // Alterar a proposta depois de assinada é detectado.
  assert.throws(() => countersignLink(kb, { ...proposal, exp: proposal.exp + DAY_MS }), /inválida/);
  // Vencido.
  assert.equal(verifyLinkCert(link, link.exp + 1).ok, false);
  // A ordem de quem propõe não importa.
  const reverse = countersignLink(ka, proposeLink(kb, db, da));
  assert.deepEqual(verifyLinkCert(reverse), { ok: true });
  assert.throws(() => proposeLink(ka, da, da), /ela mesma/);
});

test('revogação só vale se assinada pela autoridade da rede', () => {
  const { authority, id } = member();
  const target = b64.encode(id.box.publicKey);
  const r = issueRevocation(authority, target);
  assert.deepEqual(verifyRevocation(r, authority.publicKey), { ok: true });
  assert.equal(verifyRevocation(r, generateSignKeys().publicKey).ok, false);
  assert.equal(verifyRevocation({ ...r, target: b64.encode(generateIdentity2().box.publicKey) }, authority.publicKey).ok, false);
});

test('códigos para QR ida e volta, e recusam o tipo errado', () => {
  const code = encodeCode('invite', { a: 1, texto: 'ação' });
  assert.match(code, /^sigilo2-convite:/);
  assert.deepEqual(decodeCode('invite', code), { a: 1, texto: 'ação' });
  assert.throws(() => decodeCode('network', code), /tipo errado/);
});
