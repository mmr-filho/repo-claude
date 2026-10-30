import { isValidCns, isValidCpf, normalizePersonName, onlyDigits } from '@omnisaude/shared';
import { z } from 'zod';
import type { LlmClient, LlmImageMediaType } from './llm/types';
import { fold } from './text';

/**
 * Captura de documentos na recepção. A imagem (câmera do tablet ou webcam) é lida por um modelo
 * multimodal ou, sem IA, o texto de um OCR comum é interpretado por heurísticas. Em ambos os casos
 * o resultado passa por validateExtraction antes de ir para o cadastro e para a busca no CADSUS.
 */

export const DOCUMENT_TYPES = ['RG', 'CNH', 'CERTIDAO_NASCIMENTO', 'CARTAO_SUS', 'OUTRO'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface ExtractedDocument {
  docType: DocumentType;
  fullName: string | null;
  motherName: string | null;
  fatherName: string | null;
  /** AAAA-MM-DD */
  birthDate: string | null;
  cpf: string | null;
  cns: string | null;
  rg: string | null;
  sex: 'M' | 'F' | null;
  /** 0 a 1: legibilidade/certeza da leitura. */
  confidence: number;
}

export interface DocumentImage {
  data: string; // base64
  mediaType: LlmImageMediaType;
}

export interface DocumentExtractor {
  extract(image: DocumentImage): Promise<ExtractedDocument>;
}

const ExtractionSchema = z.object({
  docType: z.enum(DOCUMENT_TYPES),
  fullName: z.string().nullable(),
  motherName: z.string().nullable(),
  fatherName: z.string().nullable(),
  birthDate: z.string().nullable().describe('Data de nascimento no formato AAAA-MM-DD'),
  cpf: z.string().nullable().describe('Somente dígitos'),
  cns: z.string().nullable().describe('Número do Cartão Nacional de Saúde, somente dígitos'),
  rg: z.string().nullable(),
  sex: z.enum(['M', 'F']).nullable(),
  confidence: z.number().describe('Entre 0 e 1: quão legível e certa foi a leitura'),
});

const EXTRACTION_SYSTEM = [
  'Você lê documentos brasileiros de identificação (RG/CIN, CNH, certidão de nascimento, Cartão Nacional de Saúde) para o cadastro de pacientes do SUS.',
  'Transcreva exatamente o que está impresso; nunca deduza nem invente dados. Campo ilegível ou ausente: null.',
  'Filiação: identifique mãe e pai pelos rótulos; se a ordem não estiver indicada, em RG e CNH o primeiro nome costuma ser o do pai e o segundo o da mãe.',
  'Datas em AAAA-MM-DD. CPF e CNS apenas com dígitos.',
  'Se a imagem não for um documento de identificação, use docType OUTRO e confidence baixa.',
].join('\n');

export class LlmDocumentExtractor implements DocumentExtractor {
  constructor(private readonly llm: LlmClient) {}

  async extract(image: DocumentImage): Promise<ExtractedDocument> {
    const { output } = await this.llm.generateStructured({
      task: 'ocr-documento',
      system: EXTRACTION_SYSTEM,
      content: [
        { type: 'image', mediaType: image.mediaType, data: image.data },
        { type: 'text', text: 'Extraia os dados deste documento.' },
      ],
      schema: ExtractionSchema,
      effort: 'low',
      maxTokens: 4000,
    });
    return { ...output, confidence: Math.min(1, Math.max(0, output.confidence)) };
  }
}

// ---------------------------------------------------------------------------
// Fallback: interpretação do texto de um OCR convencional

const CPF_RE = /\b(\d{3})\.?\s?(\d{3})\.?\s?(\d{3})\s?[-.]?\s?(\d{2})\b/g;
const CNS_RE = /\b([1-2789]\d{2})\s?(\d{4})\s?(\d{4})\s?(\d{4})\b/g;
const DATE_RE = /\b(\d{2})[/.-](\d{2})[/.-](\d{4})\b/g;
const RG_RE = /\b(\d{1,2}\.?\d{3}\.?\d{3}-?[\dxX])\b/;

function detectType(f: string): DocumentType {
  if (/habilitacao|detran|permissao para dirigir/.test(f)) return 'CNH';
  if (/certidao de nascimento|registro civil/.test(f)) return 'CERTIDAO_NASCIMENTO';
  if (/cartao nacional de saude|cartao sus|\bcns\b/.test(f)) return 'CARTAO_SUS';
  if (/registro geral|carteira de identidade|identidade nacional|seguranca publica|instituto de identificacao/.test(f)) return 'RG';
  return 'OUTRO';
}

const LABEL_ONLY = /^(nome|filiacao|nome social|data de nascimento|data nascimento|nascimento|cpf|sexo|pai|mae|naturalidade|doc\.? identidade.*|registro geral|validade|n[ºo°]? registro)\s*[:.]?$/;

function isNameLike(line: string): boolean {
  const f = fold(line).trim();
  if (f.length < 5 || /\d/.test(f) || LABEL_ONLY.test(f)) return false;
  return f.split(/\s+/).length >= 2;
}

/** Valor depois de um rótulo: na mesma linha ("NOME: FULANO") ou na linha seguinte. */
function valueAfterLabel(lines: string[], labelRe: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const f = fold(lines[i]!);
    const m = labelRe.exec(f);
    if (!m) continue;
    const rest = lines[i]!.slice(m.index + m[0].length).replace(/^[\s:.-]+/, '').trim();
    if (rest && isNameLike(rest)) return rest;
    const next = lines[i + 1]?.trim();
    if (next && isNameLike(next)) return next;
  }
  return null;
}

function toIso(d: string, m: string, y: string): string {
  return `${y}-${m}-${d}`;
}

export function parseDocumentText(raw: string): ExtractedDocument {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f = fold(raw);
  const docType = detectType(f);

  const cpfs = [...raw.matchAll(CPF_RE)].map((m) => m.slice(1, 5).join(''));
  const cpf = cpfs.find(isValidCpf) ?? cpfs[0] ?? null;

  const withoutCpf = cpf ? raw.replace(CPF_RE, ' ') : raw;
  const cnsList = [...withoutCpf.matchAll(CNS_RE)].map((m) => m.slice(1, 5).join(''));
  const cns = cnsList.find(isValidCns) ?? cnsList[0] ?? null;

  // Nascimento: data perto do rótulo; senão a mais antiga (emissão e validade são posteriores).
  let birthDate: string | null = null;
  for (let i = 0; i < lines.length && !birthDate; i++) {
    if (/nasc/.test(fold(lines[i]!))) {
      const m = [...`${lines[i]} ${lines[i + 1] ?? ''}`.matchAll(DATE_RE)][0];
      if (m) birthDate = toIso(m[1]!, m[2]!, m[3]!);
    }
  }
  if (!birthDate) {
    const dates = [...raw.matchAll(DATE_RE)].map((m) => toIso(m[1]!, m[2]!, m[3]!)).sort();
    birthDate = dates[0] ?? null;
  }

  let fullName = valueAfterLabel(lines, /\bnome(?:\s+e\s+sobrenome|\s+completo)?\b(?!\s+(?:social|da mae|do pai))/);
  let motherName = valueAfterLabel(lines, /\b(?:mae|nome da mae)\b/);
  let fatherName = valueAfterLabel(lines, /\b(?:pai|nome do pai)\b/);
  if (!motherName || !fatherName) {
    const idx = lines.findIndex((l) => /filiacao/.test(fold(l)));
    if (idx !== -1) {
      const parents = lines.slice(idx + 1, idx + 4).filter(isNameLike).slice(0, 2);
      // Em RG e CNH a filiação costuma listar o pai primeiro e a mãe depois.
      if (parents.length === 2) {
        fatherName ??= parents[0]!;
        motherName ??= parents[1]!;
      } else if (parents.length === 1) {
        motherName ??= parents[0]!;
      }
    }
  }
  if (fullName && (fullName === motherName || fullName === fatherName)) fullName = null;

  let rg: string | null = null;
  const rgLine = lines.find((l) => /registro geral|doc\.? identidade|\brg\b/.test(fold(l)));
  if (rgLine) {
    const idx = lines.indexOf(rgLine);
    const m = RG_RE.exec(`${rgLine} ${lines[idx + 1] ?? ''}`);
    if (m && onlyDigits(m[1]!) !== cpf) rg = m[1]!;
  }

  const sexMatch = /\bsexo\s*[:.]?\s*(m|f|masculino|feminino)\b/.exec(f);
  const sex = sexMatch ? (sexMatch[1]!.startsWith('m') ? 'M' : 'F') : null;

  const found = [fullName, birthDate, cpf ?? cns, motherName].filter(Boolean).length;
  return {
    docType,
    fullName,
    motherName,
    fatherName,
    birthDate,
    cpf,
    cns,
    rg,
    sex,
    confidence: Math.round((found / 4) * 0.8 * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Validação e normalização

export interface ExtractionIssue {
  field: keyof ExtractedDocument;
  severity: 'erro' | 'aviso';
  message: string;
}

export interface ValidatedDocument {
  data: ExtractedDocument;
  issues: ExtractionIssue[];
  /** Sem erros: pode seguir para a busca no CADSUS (avisos pedem conferência visual). */
  valid: boolean;
}

export function validateExtraction(doc: ExtractedDocument, options: { today?: Date } = {}): ValidatedDocument {
  const today = options.today ?? new Date();
  const issues: ExtractionIssue[] = [];
  const name = (v: string | null) => (v && v.trim() ? normalizePersonName(v) : null);
  const data: ExtractedDocument = {
    ...doc,
    fullName: name(doc.fullName),
    motherName: name(doc.motherName),
    fatherName: name(doc.fatherName),
    cpf: doc.cpf ? onlyDigits(doc.cpf) || null : null,
    cns: doc.cns ? onlyDigits(doc.cns) || null : null,
    rg: doc.rg?.trim() || null,
  };

  if (!data.fullName) issues.push({ field: 'fullName', severity: 'erro', message: 'Nome não identificado no documento.' });
  if (data.cpf && !isValidCpf(data.cpf)) issues.push({ field: 'cpf', severity: 'erro', message: 'CPF lido com dígito verificador inválido.' });
  if (data.cns && !isValidCns(data.cns)) issues.push({ field: 'cns', severity: 'erro', message: 'CNS lido com dígito verificador inválido.' });
  if (!data.cpf && !data.cns) issues.push({ field: 'cpf', severity: 'aviso', message: 'Nenhum CPF ou CNS lido: a busca no CADSUS usará nome, nascimento e mãe.' });

  if (data.birthDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.birthDate);
    const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== data.birthDate) {
      issues.push({ field: 'birthDate', severity: 'erro', message: 'Data de nascimento inválida.' });
    } else if (date.getTime() > today.getTime()) {
      issues.push({ field: 'birthDate', severity: 'erro', message: 'Data de nascimento no futuro.' });
    } else if (today.getUTCFullYear() - date.getUTCFullYear() > 130) {
      issues.push({ field: 'birthDate', severity: 'aviso', message: 'Data de nascimento improvável (mais de 130 anos).' });
    }
  } else {
    issues.push({ field: 'birthDate', severity: 'aviso', message: 'Data de nascimento não identificada.' });
  }
  if (!data.motherName) issues.push({ field: 'motherName', severity: 'aviso', message: 'Nome da mãe não identificado (é usado na busca no CADSUS).' });
  if (data.confidence < 0.6) issues.push({ field: 'confidence', severity: 'aviso', message: 'Leitura com baixa confiança: confira todos os campos com o documento.' });

  return { data, issues, valid: !issues.some((i) => i.severity === 'erro') };
}
