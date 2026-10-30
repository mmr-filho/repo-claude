import { randomUUID } from 'node:crypto';
import { isValidCns, isValidCpf, onlyDigits } from '@omnisaude/shared';
import type { Bundle, BundleEntry, CodeableConcept, Composition, CompositionSection, Identifier, PractitionerRole, Reference, Resource } from 'fhir/r4';
import { BUNDLE_IDENTIFIER_PREFIX, CODE_SYSTEMS, NAMING_SYSTEMS, PROFILES } from './rnds';
import type { DocumentMeta, EstablishmentIdentity, PatientIdentity, PractitionerIdentity, ProblemInput } from './types';

export class FhirInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FhirInputError';
  }
}

/** dateTime FHIR em UTC, sem milissegundos. */
export function fhirDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function fhirDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function patientIdentifier(p: PatientIdentity): Identifier {
  if (p.cpf) {
    if (!isValidCpf(p.cpf)) throw new FhirInputError(`CPF do paciente inválido: ${p.cpf}`);
    return { system: NAMING_SYSTEMS.cpf, value: onlyDigits(p.cpf) };
  }
  if (p.cns) {
    if (!isValidCns(p.cns)) throw new FhirInputError(`CNS do paciente inválido: ${p.cns}`);
    return { system: NAMING_SYSTEMS.cns, value: onlyDigits(p.cns) };
  }
  throw new FhirInputError('Paciente sem CPF nem CNS');
}

export function practitionerIdentifier(p: PractitionerIdentity): Identifier {
  if (p.cns) {
    if (!isValidCns(p.cns)) throw new FhirInputError(`CNS do profissional inválido: ${p.cns}`);
    return { system: NAMING_SYSTEMS.cns, value: onlyDigits(p.cns) };
  }
  if (p.cpf) {
    if (!isValidCpf(p.cpf)) throw new FhirInputError(`CPF do profissional inválido: ${p.cpf}`);
    return { system: NAMING_SYSTEMS.cpf, value: onlyDigits(p.cpf) };
  }
  throw new FhirInputError('Profissional sem CNS nem CPF');
}

export function establishmentIdentifier(e: EstablishmentIdentity): Identifier {
  const cnes = onlyDigits(e.cnes);
  if (cnes.length !== 7) throw new FhirInputError(`CNES deve ter 7 dígitos: ${e.cnes}`);
  return { system: NAMING_SYSTEMS.cnes, value: cnes };
}

export function sigtapCode(code: string): string {
  const digits = onlyDigits(code);
  if (digits.length !== 10) throw new FhirInputError(`Código SIGTAP deve ter 10 dígitos: ${code}`);
  return digits;
}

export function problemCode(p: ProblemInput): CodeableConcept {
  const code = p.code.replace('.', '').toUpperCase();
  const valid = p.system === 'CID10' ? /^[A-Z]\d{2}[0-9X]?$/.test(code) : /^[A-Z]\d{2}$/.test(code);
  if (!valid) throw new FhirInputError(`Código ${p.system} inválido: ${p.code}`);
  return {
    coding: [{ system: p.system === 'CID10' ? CODE_SYSTEMS.cid10 : CODE_SYSTEMS.ciap2, code, ...(p.display ? { display: p.display } : {}) }],
  };
}

export function escapeXhtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function narrative(text: string): { status: 'generated'; div: string } {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXhtml(p)}</p>`)
    .join('');
  return { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${paragraphs}</div>` };
}

/** Monta o Bundle "document": Composition primeiro, fullUrls urn:uuid. */
export class DocumentBuilder {
  private readonly entries: BundleEntry[] = [];
  private readonly uuid: () => string;

  constructor(private readonly meta: DocumentMeta) {
    if (!meta.rndsRequesterId) throw new FhirInputError('Identificador do solicitante RNDS ausente');
    if (!meta.localId) throw new FhirInputError('Identificador local do documento ausente');
    this.uuid = meta.uuid ?? randomUUID;
  }

  /** Reserva uma urn para referenciar o recurso antes de adicioná-lo. */
  newUrn(): string {
    return `urn:uuid:${this.uuid()}`;
  }

  add<T extends Resource>(resource: T, fullUrl: string = this.newUrn()): Reference {
    this.entries.push({ fullUrl, resource });
    return { reference: fullUrl };
  }

  practitionerRole(practitioner: PractitionerIdentity, establishment: EstablishmentIdentity): Reference {
    if (!/^\d{6}$/.test(practitioner.cbo) && !/^\d{4}-\d{2}$/.test(practitioner.cbo)) {
      throw new FhirInputError(`CBO inválido: ${practitioner.cbo}`);
    }
    const role: PractitionerRole = {
      resourceType: 'PractitionerRole',
      meta: { profile: [PROFILES.practitionerRole] },
      practitioner: { identifier: practitionerIdentifier(practitioner), ...(practitioner.name ? { display: practitioner.name } : {}) },
      organization: { identifier: establishmentIdentifier(establishment), ...(establishment.name ? { display: establishment.name } : {}) },
      code: [{ coding: [{ system: CODE_SYSTEMS.cbo, code: practitioner.cbo.replace('-', '') }] }],
    };
    return this.add(role);
  }

  build(composition: Omit<Composition, 'resourceType' | 'status' | 'date'> & { date?: string }, sections: CompositionSection[]): Bundle {
    const timestamp = fhirDateTime(this.meta.timestamp ?? new Date());
    const comp: Composition = {
      resourceType: 'Composition',
      status: 'final',
      date: timestamp,
      ...composition,
      section: sections.filter((s) => (s.entry?.length ?? 0) > 0 || s.text),
    };
    return {
      resourceType: 'Bundle',
      meta: { lastUpdated: timestamp },
      identifier: { system: `${BUNDLE_IDENTIFIER_PREFIX}${this.meta.rndsRequesterId}`, value: this.meta.localId },
      type: 'document',
      timestamp,
      entry: [{ fullUrl: this.newUrn(), resource: comp }, ...this.entries],
    };
  }
}
