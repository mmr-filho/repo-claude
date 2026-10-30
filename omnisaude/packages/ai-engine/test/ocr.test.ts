import { describe, expect, it } from 'vitest';
import { FakeLlmClient, LlmDocumentExtractor, parseDocumentText, validateExtraction } from '@omnisaude/ai-engine';

const RG_TEXT = `REPÚBLICA FEDERATIVA DO BRASIL
SECRETARIA DE SEGURANÇA PÚBLICA
INSTITUTO DE IDENTIFICAÇÃO
REGISTRO GERAL 12.345.678-9    DATA DE EXPEDIÇÃO 15/03/2018
NOME
MARIA APARECIDA DA SILVA SOUZA
FILIAÇÃO
JOSÉ CARLOS DE SOUZA
ANA LÚCIA DA SILVA
NATURALIDADE SÃO PAULO-SP    DATA DE NASCIMENTO 07/09/1985
CPF 529.982.247-25`;

const CNH_TEXT = `REPÚBLICA FEDERATIVA DO BRASIL
CARTEIRA NACIONAL DE HABILITAÇÃO
NOME
JOAO PEDRO OLIVEIRA
DOC. IDENTIDADE/ÓRG. EMISSOR/UF
4567890 SSP GO
CPF 11144477735   DATA NASCIMENTO 22/01/1990
FILIAÇÃO
ANTONIO OLIVEIRA
TEREZA RIBEIRO OLIVEIRA
VALIDADE 10/05/2031  1ª HABILITAÇÃO 03/04/2010`;

const SUS_TEXT = `CARTÃO NACIONAL DE SAÚDE
SUS
Nome: Francisco das Chagas Lima
Data de Nasc.: 01/12/1948  Sexo: M
CNS 123 4567 8901 0000`;

describe('parseDocumentText', () => {
  it('RG: nome, filiação (pai, mãe), nascimento, CPF e RG', () => {
    const d = parseDocumentText(RG_TEXT);
    expect(d).toMatchObject({
      docType: 'RG',
      fullName: 'MARIA APARECIDA DA SILVA SOUZA',
      fatherName: 'JOSÉ CARLOS DE SOUZA',
      motherName: 'ANA LÚCIA DA SILVA',
      birthDate: '1985-09-07',
      cpf: '52998224725',
      rg: '12.345.678-9',
    });
    expect(d.confidence).toBeGreaterThan(0.6);
  });

  it('CNH: identifica o tipo e a data de nascimento pelo rótulo', () => {
    const d = parseDocumentText(CNH_TEXT);
    expect(d).toMatchObject({ docType: 'CNH', fullName: 'JOAO PEDRO OLIVEIRA', birthDate: '1990-01-22', cpf: '11144477735', motherName: 'TEREZA RIBEIRO OLIVEIRA' });
  });

  it('Cartão SUS: CNS com espaços, nome na mesma linha do rótulo e sexo', () => {
    const d = parseDocumentText(SUS_TEXT);
    expect(d).toMatchObject({ docType: 'CARTAO_SUS', fullName: 'Francisco das Chagas Lima', cns: '123456789010000', birthDate: '1948-12-01', sex: 'M' });
  });
});

describe('validateExtraction', () => {
  it('normaliza nomes e aponta dígitos verificadores inválidos', () => {
    const v = validateExtraction({ ...parseDocumentText(RG_TEXT), cpf: '529.982.247-26', cns: '123456789010001' });
    expect(v.data.fullName).toBe('Maria Aparecida da Silva Souza');
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => `${i.field}:${i.severity}`)).toEqual(expect.arrayContaining(['cpf:erro', 'cns:erro']));
  });

  it('recusa nascimento futuro e avisa sobre campos ausentes', () => {
    const v = validateExtraction(
      { docType: 'OUTRO', fullName: 'Fulano de Tal', motherName: null, fatherName: null, birthDate: '2030-01-01', cpf: null, cns: null, rg: null, sex: null, confidence: 0.3 },
      { today: new Date('2026-10-30') },
    );
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.field)).toEqual(expect.arrayContaining(['birthDate', 'motherName', 'confidence', 'cpf']));
    expect(validateExtraction({ ...v.data, birthDate: '1990-02-30' }).issues.some((i) => i.message.includes('inválida'))).toBe(true);
  });

  it('documento correto passa', () => {
    expect(validateExtraction(parseDocumentText(RG_TEXT)).valid).toBe(true);
  });
});

describe('LlmDocumentExtractor', () => {
  it('envia a imagem e limita a confiança entre 0 e 1', async () => {
    const llm = new FakeLlmClient([
      { docType: 'RG', fullName: 'MARIA SOUZA', motherName: 'ANA SOUZA', fatherName: null, birthDate: '1985-09-07', cpf: '52998224725', cns: null, rg: '123', sex: 'F', confidence: 1.4 },
    ]);
    const d = await new LlmDocumentExtractor(llm).extract({ data: 'iVBOR', mediaType: 'image/png' });
    expect(d.confidence).toBe(1);
    const content = llm.calls[0]!.content as { type: string }[];
    expect(content[0]).toMatchObject({ type: 'image', mediaType: 'image/png', data: 'iVBOR' });
    expect(llm.calls[0]!.effort).toBe('low');
  });
});
