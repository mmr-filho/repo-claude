import { describe, expect, it } from 'vitest';
import { describeCertificate, extractPdfSignatures, icpBrasilPerson, parsePfx, PfxError, verifyPdfSignatures } from '../src/modules/signatures/cms';
import { renderDocument, signPdf, toWinAnsi } from '../src/modules/signatures/pdf';
import { makeTestPfx } from './test-certificate';

describe('assinatura CMS/PAdES: certificado, PDF e verificação (sem banco)', () => {
  const test = makeTestPfx({
    cpf: '12345678909',
    name: 'CARLA MENEZES MEDICA',
    password: 'abc123',
  });

  it('abre o PKCS#12, encontra o titular e lê o CPF do campo da ICP-Brasil', () => {
    const parsed = parsePfx(test.pfx, 'abc123');
    expect(parsed.chain).toHaveLength(1);
    expect(icpBrasilPerson(parsed.leaf.der)).toMatchObject({
      cpf: '12345678909',
      birthDate: '19800315',
      rgIssuer: 'SSPTO',
    });
    const info = describeCertificate(parsed.leaf, parsed.chain);
    expect(info).toMatchObject({
      cpf: '12345678909',
      commonName: 'CARLA MENEZES MEDICA:12345678909',
      icpBrasil: false,
      canSign: true,
    });
    expect(info.chainError).toMatch(/ICP-Brasil/);
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(() => parsePfx(test.pfx, 'errada')).toThrowError(PfxError);
    expect(() => parsePfx(Buffer.from('isto não é um pfx'), 'abc123')).toThrowError(PfxError);
    const soCifra = parsePfx(makeTestPfx({ cpf: '12345678909', name: 'SO CIFRA', signingUsage: false }).pfx, 'senha-teste');
    expect(describeCertificate(soCifra.leaf, soCifra.chain).canSign).toBe(false);
    const semCpf = makeTestPfx({
      cpf: '00000000000',
      name: 'SEM CPF',
      withCpf: false,
    });
    expect(icpBrasilPerson(parsePfx(semCpf.pfx, 'senha-teste').leaf.der)).toBeNull();
  });

  it('gera o PDF, assina em PAdES e detecta adulteração', async () => {
    const parsed = parsePfx(test.pfx, 'abc123');
    const unsigned = await renderDocument(
      {
        title: 'Registro de atendimento',
        unit: { name: 'UBS Centro', cnes: '1234567', address: 'Rua A, 1' },
        patient: {
          name: 'Joana da Silva',
          cpf: '98765432100',
          cns: '700000000000001',
          birthDate: new Date('1990-02-03'),
        },
        professional: {
          name: 'Carla Menezes Médica',
          council: 'CRM-TO 1234',
          cbo: '225125',
          roleLabel: 'Corpo Clínico / Médico',
        },
        issuedAt: new Date('2026-10-31T12:00:00Z'),
        timeZone: 'America/Araguaina',
        sections: [
          {
            heading: 'Subjetivo',
            paragraphs: ['Dor de cabeça há 3 dias — sem febre. '.repeat(40)],
          },
          {
            heading: 'Avaliação',
            paragraphs: ['Cefaleia tensional 😀 (emoji vira ?)'],
          },
        ],
        footer: ['hash de auditoria abc'],
        signer: { name: 'Carla Menezes Médica', cpf: '12345678909' },
      },
      {
        reason: 'Assinatura do registro clínico',
        location: 'UBS Centro',
        contactInfo: 'Município',
      },
    );
    expect(unsigned.subarray(0, 5).toString()).toBe('%PDF-');
    const { pdf, cms } = await signPdf(unsigned, parsed, new Date('2026-10-31T12:00:05Z'));
    expect(cms.length).toBeGreaterThan(1000);
    const found = extractPdfSignatures(pdf);
    expect(found).toHaveLength(1);
    expect(found[0]!.coversWholeDocument).toBe(true);
    const [check] = verifyPdfSignatures(pdf);
    expect(check).toMatchObject({
      valid: true,
      digestOk: true,
      signatureOk: true,
      certificateHashOk: true,
      cpf: '12345678909',
      icpBrasil: false,
      digestAlgorithm: 'SHA256',
      certificates: 2,
    });
    expect(check!.signingTime?.toISOString()).toBe('2026-10-31T12:00:05.000Z');

    const tampered = Buffer.from(pdf);
    tampered[200] ^= 0x01;
    const [bad] = verifyPdfSignatures(tampered);
    expect(bad).toMatchObject({
      valid: false,
      digestOk: false,
      signatureOk: true,
    });
    expect(bad!.error).toMatch(/alterado/);
    expect(verifyPdfSignatures(Buffer.from('%PDF-1.4 sem assinatura'))).toEqual([]);
  });

  it('reduz o texto ao que a fonte padrão do PDF representa', () => {
    expect(toWinAnsi('ação – “aspas” € 😀\tfim')).toBe('ação – “aspas” € ?  fim');
  });
});
