import { normalizePersonName, type RouteOfAdministration } from '@omnisaude/shared';
import { fold, wordsToNumbers } from './text';

/** Comandos de voz operacionais ("chamar paciente", "prescrever dipirona", "emitir atestado"). */

export const VOICE_INTENTS = [
  'CHAMAR_PACIENTE',
  'CHAMAR_PROXIMO',
  'PRESCREVER',
  'EMITIR_ATESTADO',
  'SOLICITAR_EXAME',
  'ABRIR_PRONTUARIO',
  'ENCERRAR_ATENDIMENTO',
  'DESCONHECIDO',
] as const;
export type VoiceIntent = (typeof VOICE_INTENTS)[number];

export interface PrescriptionArgs {
  drug: string;
  dose?: number;
  unit?: string;
  intervalHours?: number;
  timesPerDay?: number;
  durationDays?: number;
  route?: RouteOfAdministration;
}

export type VoiceCommand =
  | { intent: 'CHAMAR_PACIENTE'; args: { name?: string; ticket?: string }; raw: string }
  | { intent: 'CHAMAR_PROXIMO'; args: Record<string, never>; raw: string }
  | { intent: 'PRESCREVER'; args: PrescriptionArgs; raw: string }
  | { intent: 'EMITIR_ATESTADO'; args: { days?: number; type: 'AFASTAMENTO' | 'COMPARECIMENTO' }; raw: string }
  | { intent: 'SOLICITAR_EXAME'; args: { exams: string[] }; raw: string }
  | { intent: 'ABRIR_PRONTUARIO'; args: { name?: string }; raw: string }
  | { intent: 'ENCERRAR_ATENDIMENTO'; args: Record<string, never>; raw: string }
  | { intent: 'DESCONHECIDO'; args: Record<string, never>; raw: string };

const UNITS: [RegExp, string][] = [
  [/^(?:mg|miligramas?)$/, 'mg'],
  [/^(?:g|gramas?)$/, 'g'],
  [/^(?:mcg|microgramas?)$/, 'mcg'],
  [/^(?:ml|mililitros?)$/, 'mL'],
  [/^(?:ui|unidades?)$/, 'UI'],
  [/^gotas?$/, 'gotas'],
  [/^(?:comprimidos?|cp|cps)$/, 'comprimido'],
  [/^(?:capsulas?)$/, 'cápsula'],
];

const ROUTES: [RegExp, RouteOfAdministration][] = [
  [/\b(?:via oral|vo|oral|por boca)\b/, 'ORAL'],
  [/\b(?:sublingual|sl)\b/, 'SUBLINGUAL'],
  [/\b(?:endovenos[oa]|intravenos[oa]|ev|iv|na veia)\b/, 'IV'],
  [/\b(?:intramuscular|im)\b/, 'IM'],
  [/\b(?:subcutane[oa]|sc)\b/, 'SC'],
  [/\b(?:inalatori[oa]|inalacao|nebulizacao)\b/, 'INALATORIA'],
  [/\b(?:topic[oa]|uso externo)\b/, 'TOPICA'],
];

function parsePrescription(spec: string): PrescriptionArgs {
  const s = wordsToNumbers(spec).replace(/(\d),(\d)/g, '$1.$2');
  const args: PrescriptionArgs = { drug: '' };
  const dose = /(\d+(?:\.\d+)?)\s*(mg|miligramas?|g|gramas?|mcg|microgramas?|ml|mililitros?|ui|unidades?|gotas?|comprimidos?|cps?|capsulas?)\b/.exec(s);
  let drugPart = s;
  if (dose) {
    args.dose = Number(dose[1]);
    args.unit = UNITS.find(([re]) => re.test(dose[2]!))?.[1] ?? dose[2]!;
    drugPart = s.slice(0, dose.index);
  } else {
    drugPart = s.split(/\s(?:de \d+ em|a cada|\d+ vezes|por \d+|via)\b/)[0]!;
  }
  args.drug = drugPart.replace(/\b(?:de|o|a)\s*$/, '').trim();

  const interval = /(?:de\s+)?(\d+)\s+em\s+\1\s*(?:h|horas?)\b/.exec(s) ?? /a cada\s+(\d+)\s*(?:h|horas?)\b/.exec(s) ?? /(\d+)\s*\/\s*\1\s*h/.exec(s);
  if (interval) args.intervalHours = Number(interval[1]);
  const times = /(\d+)\s*(?:x|vez|vezes)\s*(?:ao|por)\s*dia/.exec(s);
  if (times) args.timesPerDay = Number(times[1]);
  const duration = /(?:por|durante)\s+(\d+)\s+dias?/.exec(s);
  if (duration) args.durationDays = Number(duration[1]);
  const route = ROUTES.find(([re]) => re.test(s));
  if (route) args.route = route[1];
  return args;
}

/** Remove a palavra de ativação opcional ("ok omni", "omnisaúde,"). */
function stripWakeWord(f: string): number {
  const m = /^\s*(?:ok\s+|ola\s+)?omni(?:\s*saude)?\b[\s,:]*/.exec(f);
  return m ? m[0].length : 0;
}

export function parseVoiceCommand(text: string): VoiceCommand {
  const raw = text;
  const cleaned = text.trim().replace(/[.!?]+$/, '');
  const folded = fold(cleaned);
  const offset = stripWakeWord(folded);
  const f = folded.slice(offset).replace(/\s+/g, ' ');
  const original = cleaned.slice(offset).replace(/\s+/g, ' ');

  if (/^(?:chamar|chame|chama) (?:o |a )?proxim[oa](?: paciente)?$/.test(f)) {
    return { intent: 'CHAMAR_PROXIMO', args: {}, raw };
  }
  let m = /^(?:chamar|chame|chama) (?:a )?senha (.+)$/.exec(f);
  if (m) return { intent: 'CHAMAR_PACIENTE', args: { ticket: wordsToNumbers(m[1]!).replace(/\s+/g, '').toUpperCase() }, raw };
  m = /^(?:chamar|chame|chama) (?:o |a )?(?:paciente |senhora? |senhor )?(.+)$/.exec(f);
  if (m) {
    // Índices do texto dobrado valem no original (mesmo comprimento): preserva acentos do nome.
    const name = original.slice(f.length - m[1]!.length);
    return { intent: 'CHAMAR_PACIENTE', args: { name: normalizePersonName(name) }, raw };
  }
  m = /^(?:prescrever|prescreva|prescreve|receitar|receite|receita) (.+)$/.exec(f);
  if (m) return { intent: 'PRESCREVER', args: parsePrescription(m[1]!), raw };

  m = /^(?:emitir|emita|gerar|gere|fazer|faca) (?:um |o )?atestado(.*)$/.exec(f);
  if (m) {
    const rest = wordsToNumbers(m[1]!);
    const days = /(\d+)\s*dias?/.exec(rest);
    return {
      intent: 'EMITIR_ATESTADO',
      args: { type: /comparecimento/.test(rest) ? 'COMPARECIMENTO' : 'AFASTAMENTO', ...(days ? { days: Number(days[1]) } : {}) },
      raw,
    };
  }
  m = /^(?:solicitar|solicite|solicita|pedir|peca|pede) (?:o |a |os |as |um |uma )?(?:exames? (?:de |do |da )?)?(.+)$/.exec(f);
  if (m) {
    const exams = m[1]!
      .split(/\s*(?:,|\be\b)\s*/)
      .map((e) => e.replace(/^(?:o|a|os|as|um|uma|de|do|da)\s+/, '').trim())
      .filter(Boolean);
    return { intent: 'SOLICITAR_EXAME', args: { exams }, raw };
  }
  m = /^(?:abrir|abra|mostrar|mostre|ver) (?:o )?prontuario(?: d[oa] paciente| d[oa])?(?: (.+))?$/.exec(f);
  if (m) {
    const name = m[1] ? normalizePersonName(original.slice(f.length - m[1].length)) : undefined;
    return { intent: 'ABRIR_PRONTUARIO', args: name ? { name } : {}, raw };
  }
  if (/^(?:encerrar|encerre|finalizar|finalize|concluir|conclua) (?:o )?atendimento$/.test(f)) {
    return { intent: 'ENCERRAR_ATENDIMENTO', args: {}, raw };
  }
  return { intent: 'DESCONHECIDO', args: {}, raw };
}
