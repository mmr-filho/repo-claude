import forge from 'node-forge';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Gera uma AC de teste e um certificado no formato de e-CPF (CPF no campo 2.16.76.1.3.1 do subjectAltName),
 * empacotados em PKCS#12. Serve aos testes; não é uma cadeia da ICP-Brasil.
 */
const { asn1, pki } = forge;
const C = asn1.Class;
const T = asn1.Type;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return {
    privateKey: pki.privateKeyFromPem(privateKey),
    publicKey: pki.publicKeyFromPem(publicKey),
  };
}

export interface TestPfxOptions {
  cpf: string;
  name: string;
  password?: string;
  birthDate?: string;
  notAfter?: Date;
  /** false: sem o campo de pessoa física (certificado que não é e-CPF). */
  withCpf?: boolean;
  /** false: uso de chave só para cifrar (não serve para assinar). */
  signingUsage?: boolean;
}

export interface TestPfx {
  pfx: Buffer;
  pfxBase64: string;
  password: string;
  certPem: string;
  caPem: string;
}

export function makeTestPfx(opts: TestPfxOptions): TestPfx {
  const password = opts.password ?? 'senha-teste';
  const ca = keyPair();
  const leaf = keyPair();
  const now = Date.now();

  const caCert = pki.createCertificate();
  caCert.publicKey = ca.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(now - 86_400_000);
  caCert.validity.notAfter = new Date(now + 10 * 365 * 86_400_000);
  const caAttrs = [
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'ICP-Brasil' },
    { name: 'organizationalUnitName', value: 'Teste OmniSaude' },
    { name: 'commonName', value: 'AC Teste OmniSaude' },
  ];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }, { name: 'subjectKeyIdentifier' }]);
  caCert.sign(ca.privateKey, forge.md.sha256.create());

  const cert = pki.createCertificate();
  cert.publicKey = leaf.publicKey;
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(now - 86_400_000);
  cert.validity.notAfter = opts.notAfter ?? new Date(now + 2 * 365 * 86_400_000);
  cert.setSubject([
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'ICP-Brasil' },
    { name: 'organizationalUnitName', value: 'Teste' },
    { name: 'commonName', value: `${opts.name}:${opts.cpf}` },
  ]);
  cert.setIssuer(caAttrs);
  const person = `${opts.birthDate ?? '19800315'}${opts.cpf}${'0'.repeat(11)}${'0'.repeat(15)}SSPTO     `;
  const san = asn1.create(C.UNIVERSAL, T.SEQUENCE, true, [
    ...(opts.withCpf === false
      ? []
      : [
          asn1.create(C.CONTEXT_SPECIFIC, 0, true, [
            asn1.create(C.UNIVERSAL, T.OID, false, asn1.oidToDer('2.16.76.1.3.1').getBytes()),
            asn1.create(C.CONTEXT_SPECIFIC, 0, true, [asn1.create(C.UNIVERSAL, T.OCTETSTRING, false, Buffer.from(person, 'latin1').toString('binary'))]),
          ]),
        ]),
    asn1.create(C.CONTEXT_SPECIFIC, 1, false, 'teste@exemplo.com'),
  ]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    opts.signingUsage === false ? { name: 'keyUsage', keyEncipherment: true, critical: true } : { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
    { name: 'subjectAltName', value: san },
  ]);
  cert.sign(ca.privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(leaf.privateKey, [cert, caCert], password, { algorithm: '3des', generateLocalKeyId: true, friendlyName: opts.name });
  const pfx = Buffer.from(asn1.toDer(p12).getBytes(), 'binary');
  return {
    pfx,
    pfxBase64: pfx.toString('base64'),
    password,
    certPem: pki.certificateToPem(cert),
    caPem: pki.certificateToPem(caCert),
  };
}
