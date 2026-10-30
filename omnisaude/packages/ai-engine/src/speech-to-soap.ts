import type { SoapNote, VitalSigns } from '@omnisaude/shared';
import { z } from 'zod';
import { findDrugsInText } from './knowledge/drugs';
import type { LlmClient } from './llm/types';
import { fold, splitSentences, wordsToNumbers } from './text';

/**
 * Ditado clínico estruturado (Speech-to-SOAP). O ditado ao vivo é transcrito no próprio aparelho
 * (Web Speech API / SpeechRecognizer do Android); áudios gravados podem ir a um servidor de STT
 * (ver WhisperAsrProvider). Aqui a transcrição é organizada nos quatro blocos do prontuário.
 */

export interface SoapStructuringResult {
  soap: SoapNote;
  vitals: Partial<VitalSigns>;
  /** Princípios ativos citados (rótulos da base de conhecimento). */
  medications: string[];
  /** Sugestões de CID-10 (somente com IA), a confirmar pelo profissional. */
  cidSuggestions: { code: string; description: string }[];
  source: 'llm' | 'heuristic';
}

type Section = keyof SoapNote;

/**
 * Comandos falados que trocam de bloco: "subjetivo:", "objetivo", "avaliação", "plano" no início da frase.
 * Expressões naturais ("hipótese diagnóstica de...") ficam para as palavras-pista, não viram comando.
 */
const SECTION_COMMANDS: [RegExp, Section][] = [
  [/^subjetivo\b[\s:,.-]*/, 'subjective'],
  [/^objetivo\b[\s:,.-]*/, 'objective'],
  [/^avaliacao\b[\s:,.-]*/, 'assessment'],
  [/^plano\b[\s:,.-]*/, 'plan'],
];

const CUES: Record<Section, RegExp[]> = {
  subjective: [/\bqueix/, /\brefere\b/, /\brelata\b/, /\bconta que\b/, /\bnega\b/, /\binforma\b/, /\bha \d+ (?:dias|semanas|meses|horas)\b/, /\bdesde\b/, /\bsente\b/, /\bhistoria\b/, /\bhda\b/, /\bantecedente/, /\bpaciente (?:vem|veio|procura|comparece)/],
  objective: [/\bao exame\b/, /\bexame fisico\b/, /\bpa\b/, /\bpressao\b/, /\bfc\b/, /\bfr\b/, /\bfrequencia\b/, /\bsatura/, /\btemperatura\b/, /\bausculta\b/, /\bmurmurio\b/, /\bbulhas\b/, /\babdome\b/, /\bpalpa/, /\bcorad[oa]\b/, /\bhidratad[oa]\b/, /\bafebril\b/, /\beupneic[oa]\b/, /\bbeg\b/, /\bbom estado geral\b/, /\bglicemia\b/, /\bglasgow\b/, /\blucid[oa]\b/, /\borientad[oa] em\b/],
  assessment: [/\bhipotese\b/, /\bdiagnostic/, /\bhd\b/, /\bimpressao\b/, /\bsuspeita\b/, /\bcompativel com\b/, /\bquadro de\b/, /\bcid\b/],
  plan: [/\bprescrevo\b/, /\bprescrit[oa]\b/, /\bsolicito\b/, /\bsolicitad[oa]s?\b/, /\boriento\b/, /\borientad[oa] a\b/, /\bretorno\b/, /\bretornar\b/, /\bencaminh/, /\bconduta\b/, /\biniciar\b/, /\bmanter\b/, /\bsuspender\b/, /\bagendar\b/, /\batestado\b/, /\brepouso\b/],
};

function classify(sentence: string): Section | undefined {
  const f = fold(sentence);
  let best: Section | undefined;
  let bestScore = 0;
  for (const section of Object.keys(CUES) as Section[]) {
    const score = CUES[section].filter((re) => re.test(f)).length;
    if (score > bestScore) {
      best = section;
      bestScore = score;
    }
  }
  return best;
}

/** Sinais vitais citados no texto ("PA 140 por 90", "saturação 97", "temperatura 38,5", "pressão doze por oito"). */
export function extractVitals(text: string): Partial<VitalSigns> {
  const f = wordsToNumbers(fold(text)).replace(/(\d),(\d)/g, '$1.$2');
  const vitals: Partial<VitalSigns> = {};
  const num = (re: RegExp) => {
    const m = re.exec(f);
    return m ? Number(m[1]) : undefined;
  };
  const pa = /\b(?:pa|pressao(?: arterial)?)\s*(?:de|e|:)?\s*(\d{1,3})\s*(?:x|por|\/)\s*(\d{1,3})/.exec(f);
  if (pa) {
    let s = Number(pa[1]);
    let d = Number(pa[2]);
    // "12 por 8" é falado em cmHg.
    if (s < 30 && d < 30) {
      s *= 10;
      d *= 10;
    }
    vitals.systolic = s;
    vitals.diastolic = d;
  }
  const set = <K extends keyof VitalSigns>(key: K, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) vitals[key] = value as VitalSigns[K];
  };
  set('heartRate', num(/\b(?:fc|frequencia cardiaca|pulso)\s*(?:de|:)?\s*(\d{2,3})/));
  set('respiratoryRate', num(/\b(?:fr|frequencia respiratoria)\s*(?:de|:)?\s*(\d{1,2})/));
  set('temperature', num(/\b(?:temperatura|tax|temp)\s*(?:axilar)?\s*(?:de|:)?\s*(\d{2}(?:\.\d)?)/));
  set('spo2', num(/\b(?:saturacao|saturando|spo2|sat)\s*(?:de|:|em)?\s*(\d{2,3})/));
  set('glucose', num(/\b(?:glicemia(?: capilar)?|hgt|dextro)\s*(?:de|:)?\s*(\d{2,3})/));
  set('painScore', num(/\bdor\s*(?:nota|intensidade|grau)?\s*(\d{1,2})\s*(?:\/|de|em)\s*10\b/));
  return vitals;
}

/** Organização sem IA: comandos de seção falados e, na falta deles, palavras-pista por frase. */
export function heuristicSoap(transcript: string): SoapStructuringResult {
  const parts: Record<Section, string[]> = { subjective: [], objective: [], assessment: [], plan: [] };
  let current: Section = 'subjective';
  let explicit = false;

  for (const sentence of splitSentences(transcript)) {
    let text = sentence;
    const f = fold(sentence);
    const command = SECTION_COMMANDS.map(([re, section]) => ({ match: re.exec(f), section })).find((c) => c.match);
    if (command) {
      current = command.section;
      explicit = true;
      text = sentence.slice(command.match![0].length).trim();
      if (!text) continue;
    } else if (!explicit) {
      current = classify(sentence) ?? current;
    }
    parts[current].push(text);
  }

  const join = (s: Section) => parts[s].join(' ').trim();
  return {
    soap: { subjective: join('subjective'), objective: join('objective'), assessment: join('assessment'), plan: join('plan') },
    vitals: extractVitals(transcript),
    medications: findDrugsInText(transcript).map((d) => d.label),
    cidSuggestions: [],
    source: 'heuristic',
  };
}

const SoapSchema = z.object({
  subjective: z.string(),
  objective: z.string(),
  assessment: z.string(),
  plan: z.string(),
  cidSuggestions: z.array(z.object({ code: z.string(), description: z.string() })),
});

const SOAP_SYSTEM = [
  'Você organiza ditados de consultas do SUS no formato SOAP (Subjetivo, Objetivo, Avaliação, Plano).',
  'Use apenas o que foi dito: não acrescente sintomas, achados, diagnósticos ou condutas ausentes da transcrição.',
  'Preserve termos técnicos, doses e números como ditos; corrija apenas pontuação e erros evidentes de transcrição.',
  'Subjetivo: queixa e história relatadas. Objetivo: sinais vitais e exame físico. Avaliação: hipóteses diagnósticas. Plano: prescrições, exames, orientações, encaminhamentos e retorno.',
  'Bloco sem conteúdo no ditado: string vazia.',
  'Em cidSuggestions, sugira no máximo 3 códigos CID-10 compatíveis com a avaliação ditada (vazio se não houver avaliação).',
].join('\n');

export async function structureSoap(transcript: string, options: { llm?: LlmClient } = {}): Promise<SoapStructuringResult> {
  if (!options.llm) return heuristicSoap(transcript);
  const { output } = await options.llm.generateStructured({
    task: 'speech-to-soap',
    system: SOAP_SYSTEM,
    content: `Transcrição do ditado:\n${transcript}`,
    schema: SoapSchema,
    effort: 'low',
    maxTokens: 8000,
  });
  return {
    soap: { subjective: output.subjective, objective: output.objective, assessment: output.assessment, plan: output.plan },
    // Números vêm do texto original, não do modelo.
    vitals: extractVitals(transcript),
    medications: findDrugsInText(transcript).map((d) => d.label),
    cidSuggestions: output.cidSuggestions.slice(0, 3),
    source: 'llm',
  };
}
