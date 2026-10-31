import { describe, expect, it } from 'vitest';
import { BPA_C_LINE, BPA_HEADER, BPA_I_LINE, controlField, lineWidth, parseLine, renderHeader, renderLine, validateBpaFile } from '../src/modules/billing/bpa-layout';

/** Monta um arquivo BPA-I mínimo e válido para os testes. */
function sampleFile(overrides: Partial<Record<string, string | number>> = {}, headerOverrides: Partial<Parameters<typeof renderHeader>[0]> = {}) {
  const line = renderLine(BPA_I_LINE, {
    'prd-cnes': '9000036',
    'prd-cmp': '202611',
    'prd-cnsmed': '700000000000001',
    'prd-cbo': '225125',
    'prd-dtaten': '20261105',
    'prd-flh': 1,
    'prd-seq': 1,
    'prd-pa': '0301060061',
    'prd-cnspac': '700000000000002',
    'prd-sexo': 'F',
    'prd-ibge': '170950',
    'prd-cid': 'I10',
    'prd-idade': 45,
    'prd-qt': 1,
    'prd-caten': '02',
    'prd-nmpac': 'Joana da Silva Ção',
    'prd-dtnasc': '19810203',
    'prd-raca': '03',
    'prd-nac': '010',
    'prd-end-pcnte': 'Rua de 14 Novembro',
    'prd-num-pcnte': '100',
    'prd-bairro-pcnte': 'Setor Central',
    'prd-ddtel-pcnte': '63999990000',
    'prd-situacao-rua': 'N',
    ...overrides,
  });
  const header = renderHeader({
    competencia: '202611',
    lines: 1,
    sheets: 1,
    originName: 'Consórcio de Saúde',
    originAcronym: 'CIS',
    originCnpj: '12345678000199',
    destinationName: 'Secretaria Municipal de Saúde',
    destinationType: 'M',
    control: controlField([{ procedureCode: '0301060061', quantity: 1 }]),
    ...headerOverrides,
  });
  return `${header}\r\n${line}\r\n`;
}

describe('layout do BPA (documento oficial do DATASUS)', () => {
  it('tem as larguras do layout: cabeçalho 130, BPA-C 48 e BPA-I 350 (com CPF e situação de rua)', () => {
    expect(lineWidth(BPA_HEADER)).toBe(130);
    expect(lineWidth(BPA_C_LINE)).toBe(48);
    expect(lineWidth(BPA_I_LINE)).toBe(350);
    const positions = (spec: typeof BPA_I_LINE, name: string) => {
      let start = 1;
      for (const f of spec) {
        if (f.name === name) return [start, start + f.size - 1];
        start += f.size;
      }
      return null;
    };
    expect(positions(BPA_I_LINE, 'prd-cnsmed')).toEqual([16, 30]);
    expect(positions(BPA_I_LINE, 'prd-cnspac')).toEqual([60, 74]);
    expect(positions(BPA_I_LINE, 'prd-nmpac')).toEqual([113, 142]);
    expect(positions(BPA_I_LINE, 'prd-ine')).toEqual([329, 338]);
    expect(positions(BPA_I_LINE, 'prd-cpf-pcnte')).toEqual([339, 349]);
    expect(positions(BPA_I_LINE, 'prd-situacao-rua')).toEqual([350, 350]);
  });

  it('preenche numéricos com zeros, deixa em branco os numéricos opcionais e normaliza o texto', () => {
    const file = sampleFile();
    const [header, line] = file.split('\r\n');
    expect(header!.length).toBe(130);
    expect(line!.length).toBe(350);
    const v = parseLine(BPA_I_LINE, line!);
    expect(v['prd-nmpac']).toBe('JOANA DA SILVA CAO'.padEnd(30));
    expect(v['prd-cpf-pcnte']).toBe(' '.repeat(11));
    expect(v['prd-ine']).toBe(' '.repeat(10));
    expect(v['prd-naut']).toBe(' '.repeat(13));
    expect(v['prd-ddtel-pcnte']).toBe('63999990000');
    expect(v['prd-idade']).toBe('045');
    expect(v['prd-cid']).toBe('I10 ');
    expect(v['prd-situacao-rua']).toBe('N');
    expect(header!.startsWith('01#BPA#202611000001000001')).toBe(true);
    expect(controlField([{ procedureCode: '0301060061', quantity: 1 }])).toBe(((301060061 + 1) % 1111) + 1111);
  });

  it('aprova o arquivo gerado e aponta erros de controle, largura, competência e documento duplo', () => {
    const ok = validateBpaFile(sampleFile());
    expect(ok.ok).toBe(true);
    expect(ok.errors).toBe(0);
    expect(ok.records).toEqual({ total: 1, bpaC: 0, bpaI: 1, sheets: 1 });
    expect(ok.header?.control).toBe(ok.computedControl);

    const badControl = validateBpaFile(sampleFile({}, { control: 1500 }));
    expect(badControl.ok).toBe(false);
    expect(badControl.issues.some((i) => i.field === 'cbc-smt-vrf')).toBe(true);

    const both = validateBpaFile(sampleFile({ 'prd-cpf-pcnte': '12345678909' }));
    expect(both.issues.some((i) => i.field === 'prd-cpf-pcnte' && i.severity === 'erro')).toBe(true);

    const cpfOnly = validateBpaFile(sampleFile({ 'prd-cnspac': '', 'prd-cpf-pcnte': '12345678909' }));
    expect(cpfOnly.ok).toBe(true);

    const otherComp = validateBpaFile(sampleFile({ 'prd-cmp': '202610' }));
    expect(otherComp.issues.some((i) => i.field === 'prd-cmp')).toBe(true);

    const truncated = validateBpaFile(sampleFile().replace(/N\r\n$/, '\r\n'));
    expect(truncated.ok).toBe(false);
    expect(truncated.issues.some((i) => /350/.test(i.message))).toBe(true);

    const lf = validateBpaFile(sampleFile().replace(/\r\n/g, '\n'));
    expect(lf.ok).toBe(false);

    const noHeader = validateBpaFile('03abc\r\n');
    expect(noHeader.ok).toBe(false);
    expect(validateBpaFile(sampleFile({ 'prd-raca': '07' })).issues.some((i) => i.field === 'prd-raca')).toBe(true);
    expect(validateBpaFile(sampleFile({ 'prd-situacao-rua': 'X' })).issues.some((i) => i.field === 'prd-situacao-rua')).toBe(true);
  });

  it('aceita o BPA-C e confere a sequência das folhas', () => {
    const lines = [0, 1, 2].map((i) =>
      renderLine(BPA_C_LINE, { 'prd-cnes': '9000036', 'prd-cmp': '202611', 'prd-cbo': '225125', 'prd-flh': 1, 'prd-seq': i + 1, 'prd-pa': '0301010064', 'prd-idade': 30 + i, 'prd-qt': 2 }),
    );
    const control = controlField(lines.map(() => ({ procedureCode: '0301010064', quantity: 2 })));
    const header = renderHeader({ competencia: '202611', lines: 3, sheets: 1, originName: 'X', originAcronym: 'X', originCnpj: '', destinationName: 'SMS', destinationType: 'M', control });
    const file = `${header}\r\n${lines.join('\r\n')}\r\n`;
    const v = validateBpaFile(file);
    expect(v.ok).toBe(true);
    expect(v.records).toEqual({ total: 3, bpaC: 3, bpaI: 0, sheets: 1 });
    const swapped = `${header}\r\n${lines[0]}\r\n${lines[2]}\r\n${lines[1]}\r\n`;
    expect(validateBpaFile(swapped).warnings).toBeGreaterThan(0);
  });
});
