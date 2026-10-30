import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CadsusCitizen } from '@omnisaude/fhir';

/** Cidadãos FICTÍCIOS (CPF e CNS com dígitos válidos, gerados para teste) devolvidos pelo CADSUS simulado. */
export const MOCK_CITIZENS: CadsusCitizen[] = [
  {
    cpf: '52998224725',
    cns: ['203456789010002'],
    name: 'Maria da Silva Souza',
    motherName: 'Joana da Silva',
    birthDate: '1980-05-17',
    sex: 'F',
    phones: ['63999998888'],
    address: { line: 'Rua 7, 120', district: 'Centro', city: 'Gurupi', ibgeCode: '1709500', state: 'TO', postalCode: '77405070' },
  },
  {
    cpf: '12345678909',
    cns: ['170123456780008', '700123456789002'],
    name: 'José Carlos Pereira',
    motherName: 'Ana Pereira',
    fatherName: 'Carlos Pereira',
    birthDate: '1958-11-02',
    sex: 'M',
    phones: ['63984561234'],
    address: { line: 'Av. Pará, 45', district: 'Setor Bela Vista', city: 'Gurupi', ibgeCode: '1709500', state: 'TO', postalCode: '77410010' },
  },
  {
    cpf: '98765432100',
    cns: ['234567890120004'],
    name: 'Ana Beatriz Rocha',
    socialName: 'Bia Rocha',
    motherName: 'Cláudia Rocha',
    birthDate: '1995-08-23',
    sex: 'F',
    phones: ['63981112222'],
    email: 'bia.rocha@example.com',
  },
  {
    cns: ['898765432100008'],
    name: 'Raimundo Nonato Alves',
    motherName: 'Maria Nonata Alves',
    birthDate: '1947-03-12',
    sex: 'M',
    phones: [],
    address: { line: 'Zona Rural, Fazenda Boa Esperança', city: 'Dueré', ibgeCode: '1707207', state: 'TO' },
  },
  {
    cpf: '11144477735',
    cns: ['165432109870009'],
    name: 'Lucas Gabriel Santos',
    motherName: 'Fernanda Santos',
    birthDate: '2026-02-14',
    sex: 'M',
    phones: ['63992223333'],
  },
  {
    cpf: '39053344705',
    cns: ['211223344550000', '912341234123418'],
    name: 'Francisca das Chagas Lima',
    socialName: 'Chiquinha Lima',
    motherName: 'Antônia das Chagas',
    birthDate: '1972-06-30',
    sex: 'F',
    phones: ['63993334444'],
    deceased: false,
  },
];

/** CNPJ (fictício) do destinatário das NF-e simuladas: o consórcio de saúde de demonstração. */
export const DEMO_DEST_CNPJ = '04512345000185';

export interface NfeFixture {
  chave: string;
  emitCnpj: string;
  emitName: string;
  destCnpj: string;
  issuedAt: string;
  total: string;
  file: string;
  xml: string;
}

export const DEFAULT_FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function tag(xml: string, name: string, scope?: string): string | undefined {
  const src = scope ? (new RegExp(`<${scope}>([\\s\\S]*?)</${scope}>`).exec(xml)?.[1] ?? '') : xml;
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(src)?.[1];
}

/** Lê as NF-e (procNFe) do diretório de fixtures. */
export function loadNfeFixtures(dir: string = DEFAULT_FIXTURES_DIR): NfeFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.xml'))
    .sort()
    .map((file) => {
      const xml = readFileSync(join(dir, file), 'utf8');
      const chave = /Id="NFe(\d{44})"/.exec(xml)?.[1];
      if (!chave) throw new Error(`Fixture sem chave de acesso: ${file}`);
      return {
        chave,
        emitCnpj: tag(xml, 'CNPJ', 'emit') ?? '',
        emitName: tag(xml, 'xNome', 'emit') ?? '',
        destCnpj: tag(xml, 'CNPJ', 'dest') ?? '',
        issuedAt: tag(xml, 'dhEmi') ?? '',
        total: tag(xml, 'vNF') ?? '',
        file,
        xml,
      };
    });
}
