import forge from 'node-forge';
import { constants as cryptoConstants, createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { ICP_BRASIL_ROOTS } from './icp-brasil-roots';

/**
 * Assinatura digital no padrão CMS/CAdES (RFC 5652 + ESS signing-certificate-v2), usada dentro do PDF como
 * PAdES (subfiltro ETSI.CAdES.detached). Tudo em Node puro: node-forge para ASN.1 e PKCS#12, e o `crypto`
 * do Node (X509Certificate, RSA) para certificados, cadeia e assinaturas. Também lê o CPF do titular no
 * campo próprio da ICP-Brasil (OID 2.16.76.1.3.1).
 */

const { asn1, pki } = forge;
const C = asn1.Class;
const T = asn1.Type;

export const OIDS = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha1: '1.3.14.3.2.26',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsassaPss: '1.2.840.113549.1.1.10',
  subjectAltName: '2.5.29.17',
  keyUsage: '2.5.29.15',
  /** ICP-Brasil: dados da pessoa física (nascimento, CPF, NIS, RG e órgão emissor). */
  icpPessoaFisica: '2.16.76.1.3.1',
} as const;

const HASH_BY_OID: Record<string, string> = { [OIDS.sha256]: 'sha256', [OIDS.sha384]: 'sha384', [OIDS.sha512]: 'sha512', [OIDS.sha1]: 'sha1' };

type Asn1 = forge.asn1.Asn1;
const seq = (v: Asn1[]) => asn1.create(C.UNIVERSAL, T.SEQUENCE, true, v);
const set = (v: Asn1[]) => asn1.create(C.UNIVERSAL, T.SET, true, v);
const oid = (o: string) => asn1.create(C.UNIVERSAL, T.OID, false, asn1.oidToDer(o).getBytes());
const octets = (b: Buffer) => asn1.create(C.UNIVERSAL, T.OCTETSTRING, false, b.toString('binary'));
const integer = (n: number) => asn1.create(C.UNIVERSAL, T.INTEGER, false, asn1.integerToDer(n).getBytes());
const context = (tag: number, constructed: boolean, value: Asn1[] | string) => asn1.create(C.CONTEXT_SPECIFIC, tag, constructed, value);
const der = (obj: Asn1) => Buffer.from(asn1.toDer(obj).getBytes(), 'binary');
const fromDer = (buf: Buffer) => asn1.fromDer(forge.util.createBuffer(buf.toString('binary')));
const attribute = (type: string, values: Asn1[]) => seq([oid(type), set(values)]);
/** DER exige os elementos de um SET OF em ordem crescente da codificação. */
const sortedSet = (items: Asn1[]) => set([...items].sort((a, b) => Buffer.compare(der(a), der(b))));
const children = (obj: Asn1): Asn1[] => (Array.isArray(obj.value) ? (obj.value as Asn1[]) : []);
const bytesOf = (obj: Asn1) => Buffer.from(obj.value as string, 'binary');

export class PfxError extends Error {
  constructor(
    public readonly code: 'SENHA' | 'FORMATO' | 'SEM_CHAVE',
    message: string,
  ) {
    super(message);
  }
}

export interface LoadedCertificate {
  x509: X509Certificate;
  der: Buffer;
}
export interface ParsedPfx {
  keyPem: string;
  leaf: LoadedCertificate;
  /** Demais certificados do arquivo (cadeia), em ordem do emissor do titular até a raiz, quando possível. */
  chain: LoadedCertificate[];
}

function load(derBytes: Buffer): LoadedCertificate | null {
  try {
    return { x509: new X509Certificate(derBytes), der: derBytes };
  } catch {
    return null;
  }
}

/** Certificado de um "bag" do PKCS#12: o forge entrega ora o certificado, ora o CertBag que o envolve. */
function certificateFromBag(bag: forge.pkcs12.Bag): LoadedCertificate | null {
  const candidates: Buffer[] = [];
  if (bag.asn1) {
    candidates.push(der(bag.asn1));
    const wrapped = children(bag.asn1).find((el) => el.tagClass === C.CONTEXT_SPECIFIC && el.type === 0);
    const octet = wrapped ? children(wrapped)[0] : undefined;
    if (octet && typeof octet.value === 'string') candidates.push(Buffer.from(octet.value, 'binary'));
  }
  if (bag.cert) candidates.push(der(pki.certificateToAsn1(bag.cert)));
  for (const c of candidates) {
    const loaded = load(c);
    if (loaded) return loaded;
  }
  return null;
}

/** Abre um arquivo PKCS#12 (.pfx/.p12) e separa a chave, o certificado do titular e a cadeia. */
export function parsePfx(pfx: Buffer, password: string): ParsedPfx {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(fromDer(pfx), false, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/MAC could not be verified|Invalid password|decrypt/i.test(msg)) throw new PfxError('SENHA', 'Senha do certificado incorreta');
    throw new PfxError('FORMATO', 'O arquivo não é um certificado PKCS#12 (.pfx/.p12) válido');
  }
  const keyBags = [...(p12.getBags({ bagType: pki.oids.pkcs8ShroudedKeyBag })[pki.oids.pkcs8ShroudedKeyBag] ?? []), ...(p12.getBags({ bagType: pki.oids.keyBag })[pki.oids.keyBag] ?? [])];
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new PfxError('SEM_CHAVE', 'O arquivo não contém a chave privada');
  const keyPem = pki.privateKeyToPem(key);
  const publicDer = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
  const certs = (p12.getBags({ bagType: pki.oids.certBag })[pki.oids.certBag] ?? []).map(certificateFromBag).filter((c): c is LoadedCertificate => !!c);
  const leaf = certs.find((c) => c.x509.publicKey.export({ type: 'spki', format: 'der' }).equals(publicDer));
  if (!leaf) throw new PfxError('SEM_CHAVE', 'O arquivo não traz o certificado correspondente à chave privada');
  return {
    keyPem,
    leaf,
    chain: orderChain(
      leaf,
      certs.filter((c) => c !== leaf),
    ),
  };
}

const fingerprint = (c: LoadedCertificate) => c.x509.fingerprint256;
function safeVerify(cert: LoadedCertificate, issuer: LoadedCertificate): boolean {
  try {
    return cert.x509.verify(issuer.x509.publicKey);
  } catch {
    return false;
  }
}
const isSelfSigned = (c: LoadedCertificate) => c.x509.checkIssued(c.x509) && safeVerify(c, c);

/** Ordena os demais certificados a partir do emissor do titular; os que não encaixam ficam no fim. */
function orderChain(leaf: LoadedCertificate, others: LoadedCertificate[]): LoadedCertificate[] {
  const ordered: LoadedCertificate[] = [];
  const pool = [...others];
  let current = leaf;
  while (pool.length) {
    const idx = pool.findIndex((c) => fingerprint(c) !== fingerprint(current) && current.x509.checkIssued(c.x509));
    if (idx < 0) break;
    const [next] = pool.splice(idx, 1);
    ordered.push(next!);
    current = next!;
  }
  return [...ordered, ...pool];
}

/** Localiza o valor (OCTET STRING) de uma extensão X.509 pelo OID, andando no DER do certificado. */
export function findExtension(certDer: Buffer, extensionOid: string): Buffer | null {
  const tbs = children(fromDer(certDer))[0];
  const extensions = tbs ? children(tbs).find((el) => el.tagClass === C.CONTEXT_SPECIFIC && el.type === 3) : undefined;
  const list = extensions ? children(extensions)[0] : undefined;
  if (!list) return null;
  for (const ext of children(list)) {
    const parts = children(ext);
    if (!parts.length || asn1.derToOid(parts[0]!.value as string) !== extensionOid) continue;
    const value = parts[parts.length - 1]!;
    return typeof value.value === 'string' ? Buffer.from(value.value, 'binary') : null;
  }
  return null;
}

export interface IcpBrasilPerson {
  birthDate: string | null;
  cpf: string | null;
  nis: string | null;
  rg: string | null;
  rgIssuer: string | null;
}

/** Lê o campo de pessoa física da ICP-Brasil (OID 2.16.76.1.3.1) no subjectAltName; null quando não existe. */
export function icpBrasilPerson(certDer: Buffer): IcpBrasilPerson | null {
  const san = findExtension(certDer, OIDS.subjectAltName);
  if (!san) return null;
  for (const gn of children(fromDer(san))) {
    if (gn.tagClass !== C.CONTEXT_SPECIFIC || gn.type !== 0) continue;
    const [typeId, wrapper] = children(gn);
    if (!typeId || !wrapper || asn1.derToOid(typeId.value as string) !== OIDS.icpPessoaFisica) continue;
    const inner = wrapper.constructed ? children(wrapper)[0] : wrapper;
    if (!inner || typeof inner.value !== 'string') continue;
    const text = Buffer.from(inner.value, 'binary').toString('latin1');
    const field = (from: number, to: number) => {
      const v = text.slice(from, to).trim();
      return v && /[^0]/.test(v) ? v : null;
    };
    return { birthDate: field(0, 8), cpf: field(8, 19), nis: field(19, 30), rg: field(30, 45)?.replace(/^0+/, '') ?? null, rgIssuer: field(45, 55) };
  }
  return null;
}

export interface CertificateInfo {
  subject: string;
  commonName: string;
  issuer: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  fingerprint: string;
  cpf: string | null;
  birthDate: string | null;
  email: string | null;
  /** Cadeia validada até uma raiz da ICP-Brasil embarcada. */
  icpBrasil: boolean;
  /** Motivo de a cadeia não ter sido validada (cadeia incompleta, raiz desconhecida...). */
  chainError: string | null;
  canSign: boolean;
}

/**
 * KeyUsage (RFC 5280): sem a extensão, vale tudo; com ela, exige digitalSignature (bit 0) ou
 * nonRepudiation/contentCommitment (bit 1). O `keyUsage` do X509Certificate do Node traz os OIDs de uso
 * estendido, não estes bits, por isso a leitura é feita no DER.
 */
export function keyUsageAllowsSigning(certDer: Buffer): boolean {
  const ext = findExtension(certDer, OIDS.keyUsage);
  if (!ext) return true;
  const bits = fromDer(ext);
  if (bits.type !== T.BITSTRING || typeof bits.value !== 'string' || bits.value.length < 2) return false;
  const first = bits.value.charCodeAt(1);
  return (first & 0x80) !== 0 || (first & 0x40) !== 0;
}

/** "C=BR\nO=ICP-Brasil\nCN=Fulano" (formato do Node) vira "C=BR, O=ICP-Brasil, CN=Fulano". */
const nameToString = (name: string) => name.split('\n').filter(Boolean).join(', ');
const commonNameOf = (name: string) => /^CN=(.*)$/m.exec(name)?.[1] ?? nameToString(name);
const dateOf = (s: string) => new Date(s);
const hexFingerprint = (c: LoadedCertificate) => c.x509.fingerprint256.replace(/:/g, '').toLowerCase();
const withinValidity = (c: LoadedCertificate, at: Date) => at >= dateOf(c.x509.validFrom) && at <= dateOf(c.x509.validTo);

/** Resume o certificado e confere a cadeia com as raízes da ICP-Brasil. */
export function describeCertificate(leaf: LoadedCertificate, chain: LoadedCertificate[], at: Date = new Date()): CertificateInfo {
  const x = leaf.x509;
  const person = icpBrasilPerson(leaf.der);
  const email = /(?:^|, )email:([^,\s]+)/.exec(x.subjectAltName ?? '')?.[1] ?? null;
  const canSign = keyUsageAllowsSigning(leaf.der);
  const trust = verifyChain(leaf, chain, at);
  return {
    subject: nameToString(x.subject),
    commonName: commonNameOf(x.subject),
    issuer: nameToString(x.issuer),
    serial: x.serialNumber.toLowerCase(),
    notBefore: dateOf(x.validFrom),
    notAfter: dateOf(x.validTo),
    fingerprint: hexFingerprint(leaf),
    cpf: person?.cpf ?? null,
    birthDate: person?.birthDate ?? null,
    email,
    icpBrasil: trust.ok,
    chainError: trust.error,
    canSign,
  };
}

let rootList: LoadedCertificate[] | null = null;
function roots(): LoadedCertificate[] {
  if (!rootList) {
    rootList = ICP_BRASIL_ROOTS.map((r) => {
      const x509 = new X509Certificate(r.pem);
      return { x509, der: Buffer.from(x509.raw) };
    });
  }
  return rootList;
}

/**
 * Valida a cadeia até uma raiz da ICP-Brasil embarcada, na data informada (a da assinatura, para documentos
 * antigos). Não consulta LCR/OCSP: revogação fica para a validação externa (validador do ITI).
 */
export function verifyChain(leaf: LoadedCertificate, chain: LoadedCertificate[], at: Date): { ok: boolean; error: string | null } {
  let current = leaf;
  const seen = new Set<string>([fingerprint(leaf)]);
  for (let depth = 0; depth <= 8; depth++) {
    if (!withinValidity(current, at)) return { ok: false, error: `certificado "${commonNameOf(current.x509.subject)}" fora do período de validade` };
    const root = roots().find((r) => current.x509.checkIssued(r.x509) && safeVerify(current, r));
    if (root) return withinValidity(root, at) ? { ok: true, error: null } : { ok: false, error: `raiz ${commonNameOf(root.x509.subject)} fora do período de validade` };
    const issuer = chain.find((c) => !seen.has(fingerprint(c)) && current.x509.checkIssued(c.x509) && safeVerify(current, c));
    if (!issuer) {
      return isSelfSigned(current)
        ? { ok: false, error: `a cadeia termina em uma raiz que não é da ICP-Brasil (${commonNameOf(current.x509.subject)})` }
        : { ok: false, error: `emissor "${commonNameOf(current.x509.issuer)}" não encontrado entre as autoridades da ICP-Brasil (cadeia incompleta ou certificado de outra infraestrutura)` };
    }
    seen.add(fingerprint(issuer));
    current = issuer;
  }
  return { ok: false, error: 'cadeia de certificados longa demais' };
}

function tbsParts(certAsn1: Asn1): { serial: Asn1; issuer: Asn1 } {
  const tbs = children(certAsn1)[0]!;
  const parts = children(tbs);
  const hasVersion = parts[0]!.tagClass === C.CONTEXT_SPECIFIC;
  return { serial: parts[hasVersion ? 1 : 0]!, issuer: parts[hasVersion ? 3 : 2]! };
}

export interface BuildCmsInput {
  content: Buffer;
  pfx: ParsedPfx;
  signingTime: Date;
}

/**
 * CMS SignedData destacado (sem o conteúdo), SHA-256 + RSA PKCS#1 v1.5, com os atributos assinados
 * contentType, signingTime, messageDigest e signingCertificateV2 (CAdES-BES), e a cadeia de certificados.
 */
export function buildCms({ content, pfx, signingTime }: BuildCmsInput): Buffer {
  const digest = createHash('sha256').update(content).digest();
  const leafAsn1 = fromDer(pfx.leaf.der);
  const { serial, issuer } = tbsParts(leafAsn1);
  const essCertIdV2 = seq([octets(createHash('sha256').update(pfx.leaf.der).digest()), seq([seq([context(4, true, [issuer])]), serial])]);
  const signedAttrs = sortedSet([
    attribute(OIDS.contentType, [oid(OIDS.data)]),
    attribute(OIDS.signingTime, [asn1.create(C.UNIVERSAL, T.UTCTIME, false, asn1.dateToUtcTime(signingTime))]),
    attribute(OIDS.messageDigest, [octets(digest)]),
    attribute(OIDS.signingCertificateV2, [seq([seq([essCertIdV2])])]),
  ]);
  const signature = cryptoSign('sha256', der(signedAttrs), pfx.keyPem);
  const signerInfo = seq([
    integer(1),
    seq([issuer, serial]),
    seq([oid(OIDS.sha256)]),
    context(0, true, children(signedAttrs)),
    seq([oid(OIDS.rsaEncryption), asn1.create(C.UNIVERSAL, T.NULL, false, '')]),
    octets(signature),
  ]);
  const signedData = seq([integer(1), set([seq([oid(OIDS.sha256)])]), seq([oid(OIDS.data)]), context(0, true, [leafAsn1, ...pfx.chain.map((c) => fromDer(c.der))]), set([signerInfo])]);
  return der(seq([oid(OIDS.signedData), context(0, true, [signedData])]));
}

export interface SignatureCheck {
  valid: boolean;
  digestOk: boolean;
  signatureOk: boolean;
  /** Atributo signing-certificate(-v2) confere com o certificado do signatário; null quando ausente. */
  certificateHashOk: boolean | null;
  signingTime: Date | null;
  digestAlgorithm: string;
  subject: string;
  commonName: string;
  issuer: string;
  cpf: string | null;
  notBefore: Date;
  notAfter: Date;
  icpBrasil: boolean;
  chainError: string | null;
  certificates: number;
  error: string | null;
}

/** Verifica uma assinatura CMS destacada sobre o conteúdo: resumo, assinatura RSA, certificado e cadeia. */
export function verifyCms(cms: Buffer, content: Buffer): SignatureCheck {
  const root = fromDer(cms);
  if (asn1.derToOid(children(root)[0]!.value as string) !== OIDS.signedData) throw new Error('A assinatura não é um CMS SignedData');
  const signedData = children(children(root)[1]!)[0]!;
  let certsSet: Asn1 | null = null;
  let signerInfos: Asn1 | null = null;
  for (const el of children(signedData).slice(3)) {
    if (el.tagClass === C.CONTEXT_SPECIFIC && el.type === 0) certsSet = el;
    else if (el.tagClass === C.UNIVERSAL && el.type === T.SET) signerInfos = el;
  }
  const certs = children(certsSet ?? set([]))
    .filter((c) => c.tagClass === C.UNIVERSAL && c.type === T.SEQUENCE)
    .map((c) => load(der(c)))
    .filter((c): c is LoadedCertificate => !!c);
  const signerInfo = children(signerInfos ?? set([]))[0];
  if (!signerInfo) throw new Error('A assinatura não tem signatário');
  const parts = children(signerInfo);
  const sid = parts[1]!;
  const digestOid = asn1.derToOid(children(parts[2]!)[0]!.value as string);
  const hashName = HASH_BY_OID[digestOid];
  if (!hashName) throw new Error(`Algoritmo de resumo não suportado: ${digestOid}`);
  let i = 3;
  let signedAttrs: Asn1 | null = null;
  if (parts[3]!.tagClass === C.CONTEXT_SPECIFIC && parts[3]!.type === 0) {
    signedAttrs = parts[3]!;
    i = 4;
  }
  if (!signedAttrs) throw new Error('Assinatura sem atributos assinados (não é CAdES)');
  const signatureAlgorithm = asn1.derToOid(children(parts[i]!)[0]!.value as string);
  const signature = bytesOf(parts[i + 1]!);

  const issuerDer = der(children(sid)[0]!);
  const serialDer = der(children(sid)[1]!);
  const signer = certs.find((c) => {
    const p = tbsParts(fromDer(c.der));
    return der(p.issuer).equals(issuerDer) && der(p.serial).equals(serialDer);
  });
  if (!signer) throw new Error('O certificado do signatário não está na assinatura');

  const attrs = children(signedAttrs).map((a) => ({ type: asn1.derToOid(children(a)[0]!.value as string), values: children(children(a)[1]!) }));
  const messageDigest = attrs.find((a) => a.type === OIDS.messageDigest);
  const digestOk = !!messageDigest && bytesOf(messageDigest.values[0]!).equals(createHash(hashName).update(content).digest());
  const signedBytes = der(set(children(signedAttrs)));
  let signatureOk = false;
  try {
    signatureOk =
      signatureAlgorithm === OIDS.rsassaPss
        ? cryptoVerify(hashName, signedBytes, { key: signer.x509.publicKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING }, signature)
        : cryptoVerify(hashName, signedBytes, signer.x509.publicKey, signature);
  } catch {
    signatureOk = false;
  }
  const timeAttr = attrs.find((a) => a.type === OIDS.signingTime)?.values[0];
  const signingTime = timeAttr ? (timeAttr.type === T.UTCTIME ? asn1.utcTimeToDate(timeAttr.value as string) : asn1.generalizedTimeToDate(timeAttr.value as string)) : null;
  const ess = attrs.find((a) => a.type === OIDS.signingCertificateV2);
  let certificateHashOk: boolean | null = null;
  if (ess) {
    const certId = children(children(children(ess.values[0]!)[0]!)[0]!);
    const hashAlgorithm = certId[0]!.type === T.SEQUENCE ? asn1.derToOid(children(certId[0]!)[0]!.value as string) : OIDS.sha256;
    const hashEl = certId[0]!.type === T.SEQUENCE ? certId[1]! : certId[0]!;
    certificateHashOk = bytesOf(hashEl).equals(
      createHash(HASH_BY_OID[hashAlgorithm] ?? 'sha256')
        .update(signer.der)
        .digest(),
    );
  }
  const at = signingTime ?? new Date();
  const trust = verifyChain(
    signer,
    certs.filter((c) => c !== signer),
    at,
  );
  const inValidity = withinValidity(signer, at);
  const person = icpBrasilPerson(signer.der);
  return {
    valid: digestOk && signatureOk && certificateHashOk !== false && inValidity,
    digestOk,
    signatureOk,
    certificateHashOk,
    signingTime,
    digestAlgorithm: hashName.toUpperCase(),
    subject: nameToString(signer.x509.subject),
    commonName: commonNameOf(signer.x509.subject),
    issuer: nameToString(signer.x509.issuer),
    cpf: person?.cpf ?? null,
    notBefore: dateOf(signer.x509.validFrom),
    notAfter: dateOf(signer.x509.validTo),
    icpBrasil: trust.ok,
    chainError: trust.error,
    certificates: certs.length,
    error: !digestOk
      ? 'O conteúdo foi alterado depois da assinatura'
      : !signatureOk
        ? 'A assinatura não confere com o certificado'
        : certificateHashOk === false
          ? 'O certificado da assinatura não é o declarado'
          : !inValidity
            ? 'Certificado fora da validade na data da assinatura'
            : null,
  };
}

/** Comprimento total (cabeçalho + conteúdo) do primeiro elemento DER, para descartar o preenchimento do PDF. */
export function derTotalLength(buf: Buffer): number {
  let i = 1;
  let len = buf[i++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++]!;
  }
  return i + len;
}

export interface PdfSignature {
  byteRange: [number, number, number, number];
  content: Buffer;
  cms: Buffer;
  /** A assinatura cobre o arquivo inteiro (não houve alterações incrementais depois dela). */
  coversWholeDocument: boolean;
}

/** Localiza as assinaturas (/ByteRange + /Contents) de um PDF. */
export function extractPdfSignatures(pdf: Buffer): PdfSignature[] {
  const text = pdf.toString('latin1');
  const out: PdfSignature[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
    if (a !== 0 || b > c || c + d > pdf.length) continue;
    const gap = text.slice(b, c);
    if (!gap.startsWith('<') || !gap.endsWith('>')) continue;
    const hex = gap.slice(1, -1).replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length < 4) continue;
    const raw = Buffer.from(hex, 'hex');
    const cms = raw.subarray(0, Math.min(raw.length, derTotalLength(raw)));
    out.push({ byteRange: [a, b, c, d], content: Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]), cms, coversWholeDocument: c + d === pdf.length });
  }
  return out;
}

export interface PdfSignatureCheck extends SignatureCheck {
  coversWholeDocument: boolean;
}

/** Verifica todas as assinaturas de um PDF. Erros de leitura viram assinaturas inválidas com o motivo. */
export function verifyPdfSignatures(pdf: Buffer): PdfSignatureCheck[] {
  return extractPdfSignatures(pdf).map((s) => {
    try {
      return { ...verifyCms(s.cms, s.content), coversWholeDocument: s.coversWholeDocument };
    } catch (err) {
      return {
        valid: false,
        digestOk: false,
        signatureOk: false,
        certificateHashOk: null,
        signingTime: null,
        digestAlgorithm: '',
        subject: '',
        commonName: '',
        issuer: '',
        cpf: null,
        notBefore: new Date(0),
        notAfter: new Date(0),
        icpBrasil: false,
        chainError: null,
        certificates: 0,
        error: err instanceof Error ? err.message : String(err),
        coversWholeDocument: s.coversWholeDocument,
      };
    }
  });
}
