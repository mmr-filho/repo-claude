import { isValidCns, isValidCpf, onlyDigits } from '@omnisaude/shared';
import type { Extension, HumanName, Patient } from 'fhir/r4';
import type { RndsClient } from './client';
import { NAMING_SYSTEMS } from './rnds';

/** Cidadão retornado pelo CADSUS (consulta via RNDS). */
export interface CadsusCitizen {
  cpf?: string;
  /** Todos os CNS vinculados; o definitivo (oficial) vem primeiro quando informado. */
  cns: string[];
  name: string;
  socialName?: string;
  motherName?: string;
  fatherName?: string;
  birthDate?: string; // AAAA-MM-DD
  sex?: 'M' | 'F' | 'I';
  phones: string[];
  email?: string;
  deceased?: boolean;
  address?: {
    line?: string;
    district?: string;
    city?: string;
    /** Código IBGE do município, quando informado. */
    ibgeCode?: string;
    state?: string;
    postalCode?: string;
  };
}

export interface CadsusClient {
  findByCpf(cpf: string): Promise<CadsusCitizen | null>;
  findByCns(cns: string): Promise<CadsusCitizen | null>;
}

export class CadsusInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CadsusInputError';
  }
}

/** URLs das extensões de filiação usadas pelo simulador; a RNDS pode usar Patient.contact (MTH/FTH), também aceito. */
export const FILIATION_EXTENSIONS = {
  mother: 'https://saude.gov.br/fhir/r4/StructureDefinition/BRNomeMae',
  father: 'https://saude.gov.br/fhir/r4/StructureDefinition/BRNomePai',
  municipality: 'https://saude.gov.br/fhir/r4/StructureDefinition/BRMunicipio',
} as const;

function nameText(n: HumanName | undefined): string | undefined {
  if (!n) return undefined;
  if (n.text) return n.text;
  const parts = [...(n.given ?? []), n.family].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

function extensionString(exts: Extension[] | undefined, match: (url: string) => boolean): string | undefined {
  const e = exts?.find((x) => match(x.url));
  return e?.valueString ?? e?.valueCode ?? e?.valueHumanName?.text;
}

export function patientToCitizen(p: Patient): CadsusCitizen {
  let cpf: string | undefined;
  const official: string[] = [];
  const others: string[] = [];
  for (const id of p.identifier ?? []) {
    if (!id.value) continue;
    if (id.system === NAMING_SYSTEMS.cpf) cpf = onlyDigits(id.value);
    if (id.system === NAMING_SYSTEMS.cns) (id.use === 'official' ? official : others).push(onlyDigits(id.value));
  }
  const names = p.name ?? [];
  const civil = names.find((n) => n.use === 'official') ?? names.find((n) => n.use !== 'usual') ?? names[0];
  const social = names.find((n) => n.use === 'usual' && n !== civil);
  const contactName = (code: string) =>
    nameText(p.contact?.find((c) => c.relationship?.some((r) => r.coding?.some((x) => x.code === code)))?.name);
  const motherName = extensionString(p.extension, (u) => /NomeMae$/i.test(u)) ?? contactName('MTH');
  const fatherName = extensionString(p.extension, (u) => /NomePai$/i.test(u)) ?? contactName('FTH');
  const phones = (p.telecom ?? []).filter((t) => t.system === 'phone' && t.value).map((t) => onlyDigits(t.value!));
  const email = p.telecom?.find((t) => t.system === 'email')?.value;
  const addr = p.address?.[0];
  const sex = p.gender === 'male' ? 'M' : p.gender === 'female' ? 'F' : p.gender ? 'I' : undefined;
  const ibgeCode = extensionString(addr?.extension, (u) => /Municipio$/i.test(u));
  const deceased = p.deceasedBoolean ?? (p.deceasedDateTime ? true : undefined);

  return {
    ...(cpf ? { cpf } : {}),
    cns: [...official, ...others],
    name: nameText(civil) ?? '',
    ...(nameText(social) ? { socialName: nameText(social)! } : {}),
    ...(motherName ? { motherName } : {}),
    ...(fatherName ? { fatherName } : {}),
    ...(p.birthDate ? { birthDate: p.birthDate } : {}),
    ...(sex ? { sex } : {}),
    phones,
    ...(email ? { email } : {}),
    ...(deceased !== undefined ? { deceased } : {}),
    ...(addr
      ? {
          address: {
            ...(addr.line?.length ? { line: addr.line.join(', ') } : {}),
            ...(addr.district ? { district: addr.district } : {}),
            ...(addr.city ? { city: addr.city } : {}),
            ...(ibgeCode ? { ibgeCode } : {}),
            ...(addr.state ? { state: addr.state } : {}),
            ...(addr.postalCode ? { postalCode: onlyDigits(addr.postalCode) } : {}),
          },
        }
      : {}),
  };
}

/** Caminho inverso (usado pelo simulador e por testes): monta um Patient no formato que patientToCitizen lê. */
export function citizenToPatient(c: CadsusCitizen, id?: string): Patient {
  return {
    resourceType: 'Patient',
    ...(id ? { id } : {}),
    identifier: [
      ...(c.cpf ? [{ system: NAMING_SYSTEMS.cpf, value: c.cpf }] : []),
      ...c.cns.map((cns, i) => ({ use: (i === 0 && /^[12]/.test(cns) ? 'official' : 'temp') as 'official' | 'temp', system: NAMING_SYSTEMS.cns, value: cns })),
    ],
    name: [{ use: 'official', text: c.name }, ...(c.socialName ? [{ use: 'usual' as const, text: c.socialName }] : [])],
    ...(c.motherName || c.fatherName
      ? {
          extension: [
            ...(c.motherName ? [{ url: FILIATION_EXTENSIONS.mother, valueString: c.motherName }] : []),
            ...(c.fatherName ? [{ url: FILIATION_EXTENSIONS.father, valueString: c.fatherName }] : []),
          ],
        }
      : {}),
    ...(c.sex ? { gender: c.sex === 'M' ? 'male' : c.sex === 'F' ? 'female' : 'unknown' } : {}),
    ...(c.birthDate ? { birthDate: c.birthDate } : {}),
    ...(c.deceased !== undefined ? { deceasedBoolean: c.deceased } : {}),
    telecom: [
      ...c.phones.map((value) => ({ system: 'phone' as const, value })),
      ...(c.email ? [{ system: 'email' as const, value: c.email }] : []),
    ],
    ...(c.address
      ? {
          address: [
            {
              ...(c.address.line ? { line: [c.address.line] } : {}),
              ...(c.address.district ? { district: c.address.district } : {}),
              ...(c.address.city ? { city: c.address.city } : {}),
              ...(c.address.state ? { state: c.address.state } : {}),
              ...(c.address.postalCode ? { postalCode: c.address.postalCode } : {}),
              ...(c.address.ibgeCode ? { extension: [{ url: FILIATION_EXTENSIONS.municipality, valueCode: c.address.ibgeCode }] } : {}),
            },
          ],
        }
      : {}),
  };
}

export class RndsCadsusClient implements CadsusClient {
  constructor(private readonly rnds: Pick<RndsClient, 'searchPatient'>) {}

  async findByCpf(cpf: string): Promise<CadsusCitizen | null> {
    if (!isValidCpf(cpf)) throw new CadsusInputError(`CPF inválido: ${cpf}`);
    return this.first(await this.rnds.searchPatient({ cpf }));
  }

  async findByCns(cns: string): Promise<CadsusCitizen | null> {
    if (!isValidCns(cns)) throw new CadsusInputError(`CNS inválido: ${cns}`);
    return this.first(await this.rnds.searchPatient({ cns }));
  }

  private first(bundle: { entry?: { resource?: { resourceType: string } }[] }): CadsusCitizen | null {
    const patient = bundle.entry?.map((e) => e.resource).find((r): r is Patient => r?.resourceType === 'Patient');
    return patient ? patientToCitizen(patient) : null;
  }
}
