import { isValidCns, isValidCpf } from '@omnisaude/shared';
import { z } from 'zod';
import { BUNDLE_IDENTIFIER_PREFIX, NAMING_SYSTEMS, RNDS_BASE } from './rnds';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const FHIR_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const FHIR_DATE_TIME =
  /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00)))?)?)?$/;
const URN_UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_KEYS = new Set(['birthDate', 'expirationDate', 'recordedDate']);
const DATE_TIME_KEYS = new Set([
  'date',
  'timestamp',
  'lastUpdated',
  'start',
  'end',
  'occurrenceDateTime',
  'effectiveDateTime',
  'performedDateTime',
  'whenHandedOver',
  'whenPrepared',
  'authoredOn',
  'issued',
]);

const bundleSchema = z.object({
  resourceType: z.literal('Bundle'),
  type: z.literal('document'),
  timestamp: z.string(),
  identifier: z.object({ system: z.string(), value: z.string().min(1) }),
  entry: z
    .array(
      z.object({
        fullUrl: z.string(),
        resource: z.object({ resourceType: z.string(), meta: z.object({ profile: z.array(z.string()).optional() }).loose().optional() }).loose(),
      }),
    )
    .min(1),
});

/**
 * Validação estrutural antes do envio à RNDS: não substitui o validador oficial HL7/RNDS, mas pega os erros
 * mais comuns (referências quebradas, CPF/CNS inválidos, datas fora do formato, perfis ausentes).
 */
export function validateRndsBundle(bundle: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message });

  const parsed = bundleSchema.safeParse(bundle);
  if (!parsed.success) {
    for (const i of parsed.error.issues) error(i.path.join('.') || 'Bundle', i.message);
    return { valid: false, issues };
  }
  const b = parsed.data;
  if (!b.identifier.system.startsWith(BUNDLE_IDENTIFIER_PREFIX)) {
    error('Bundle.identifier.system', `Deve começar com ${BUNDLE_IDENTIFIER_PREFIX}`);
  }
  if (!FHIR_DATE_TIME.test(b.timestamp) || !b.timestamp.includes('T')) error('Bundle.timestamp', 'Data e hora inválida');

  const fullUrls = new Set<string>();
  b.entry.forEach((e, i) => {
    if (!URN_UUID.test(e.fullUrl)) error(`Bundle.entry[${i}].fullUrl`, 'fullUrl deve ser urn:uuid');
    if (fullUrls.has(e.fullUrl)) error(`Bundle.entry[${i}].fullUrl`, 'fullUrl duplicado');
    fullUrls.add(e.fullUrl);
  });

  const first = b.entry[0]!.resource;
  if (first.resourceType !== 'Composition') error('Bundle.entry[0]', 'O primeiro recurso de um documento deve ser a Composition');
  else if (!first.meta?.profile?.length) error('Bundle.entry[0].resource.meta.profile', 'Composition sem perfil RNDS');
  if (first.resourceType === 'Composition' && !(first as { subject?: unknown }).subject) {
    error('Bundle.entry[0].resource.subject', 'Composition sem paciente');
  }

  b.entry.forEach((e, i) => {
    const profiles = e.resource.meta?.profile ?? [];
    if (!profiles.some((p) => p.startsWith(`${RNDS_BASE}/StructureDefinition/`))) {
      warn(`Bundle.entry[${i}].resource.meta.profile`, `${e.resource.resourceType} sem perfil RNDS declarado`);
    }
    walk(e.resource, `Bundle.entry[${i}].resource`, (key, value, path, parent) => {
      if (key === 'reference' && typeof value === 'string') {
        if (value.startsWith('urn:uuid:')) {
          if (!fullUrls.has(value)) error(path, `Referência não encontrada no Bundle: ${value}`);
        } else {
          error(path, `Documentos RNDS só aceitam referências urn:uuid internas ou por identificador: ${value}`);
        }
      }
      if (key === 'system' && typeof value === 'string' && parent && typeof parent.value === 'string') {
        const v = parent.value;
        if (value === NAMING_SYSTEMS.cpf && !isValidCpf(v)) error(path.replace(/\.system$/, '.value'), `CPF inválido: ${v}`);
        if (value === NAMING_SYSTEMS.cns && !isValidCns(v)) error(path.replace(/\.system$/, '.value'), `CNS inválido: ${v}`);
        if (value === NAMING_SYSTEMS.cnes && !/^\d{7}$/.test(v)) error(path.replace(/\.system$/, '.value'), `CNES inválido: ${v}`);
      }
      if (typeof value === 'string' && DATE_TIME_KEYS.has(key) && !FHIR_DATE_TIME.test(value)) {
        error(path, `Data/hora fora do formato FHIR: ${value}`);
      }
      if (typeof value === 'string' && DATE_KEYS.has(key) && !FHIR_DATE.test(value) && !FHIR_DATE_TIME.test(value)) {
        error(path, `Data fora do formato FHIR: ${value}`);
      }
    });
  });

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

type Visitor = (key: string, value: unknown, path: string, parent: Record<string, unknown> | null) => void;

function walk(node: unknown, path: string, visit: Visitor): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, visit));
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      // Narrativa XHTML não é estrutura FHIR navegável.
      if (key === 'div') continue;
      const childPath = `${path}.${key}`;
      visit(key, value, childPath, obj);
      walk(value, childPath, visit);
    }
  }
}
