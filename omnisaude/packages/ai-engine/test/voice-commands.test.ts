import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from '@omnisaude/ai-engine';

describe('parseVoiceCommand', () => {
  it('chamar paciente pelo nome preserva acentos', () => {
    expect(parseVoiceCommand('Chamar paciente maria joséfa da silva')).toMatchObject({ intent: 'CHAMAR_PACIENTE', args: { name: 'Maria Joséfa da Silva' } });
    expect(parseVoiceCommand('ok omni, chame a senhora Conceição')).toMatchObject({ intent: 'CHAMAR_PACIENTE', args: { name: 'Conceição' } });
  });

  it('chamar próximo e chamar senha', () => {
    expect(parseVoiceCommand('chamar próximo').intent).toBe('CHAMAR_PROXIMO');
    expect(parseVoiceCommand('Chamar o próximo paciente.').intent).toBe('CHAMAR_PROXIMO');
    expect(parseVoiceCommand('chamar senha A vinte e três')).toMatchObject({ intent: 'CHAMAR_PACIENTE', args: { ticket: 'A23' } });
  });

  it('prescrever com dose, intervalo, duração e via', () => {
    expect(parseVoiceCommand('prescrever dipirona 500 miligramas de 6 em 6 horas')).toMatchObject({
      intent: 'PRESCREVER',
      args: { drug: 'dipirona', dose: 500, unit: 'mg', intervalHours: 6 },
    });
    expect(parseVoiceCommand('Prescrever dipirona quinhentos mg').args).toEqual({ drug: 'dipirona', dose: 500, unit: 'mg' });
    expect(parseVoiceCommand('prescreva amoxicilina 875 mg de doze em doze horas por sete dias via oral').args).toEqual({
      drug: 'amoxicilina',
      dose: 875,
      unit: 'mg',
      intervalHours: 12,
      durationDays: 7,
      route: 'ORAL',
    });
    expect(parseVoiceCommand('receitar ceftriaxona um grama endovenosa uma vez ao dia').args).toMatchObject({ drug: 'ceftriaxona', dose: 1, unit: 'g', route: 'IV', timesPerDay: 1 });
  });

  it('atestado, exames, prontuário e encerramento', () => {
    expect(parseVoiceCommand('emitir atestado de 3 dias')).toMatchObject({ intent: 'EMITIR_ATESTADO', args: { days: 3, type: 'AFASTAMENTO' } });
    expect(parseVoiceCommand('Emitir atestado de comparecimento').args).toEqual({ type: 'COMPARECIMENTO' });
    expect(parseVoiceCommand('emitir atestado de dois dias').args).toMatchObject({ days: 2 });
    expect(parseVoiceCommand('solicitar hemograma')).toMatchObject({ intent: 'SOLICITAR_EXAME', args: { exams: ['hemograma'] } });
    expect(parseVoiceCommand('solicitar exames de glicemia, creatinina e potássio').args).toEqual({ exams: ['glicemia', 'creatinina', 'potassio'] });
    expect(parseVoiceCommand('abrir prontuário do paciente João Lima')).toMatchObject({ intent: 'ABRIR_PRONTUARIO', args: { name: 'João Lima' } });
    expect(parseVoiceCommand('encerrar atendimento').intent).toBe('ENCERRAR_ATENDIMENTO');
  });

  it('desconhecido', () => {
    expect(parseVoiceCommand('qual a previsão do tempo').intent).toBe('DESCONHECIDO');
    expect(parseVoiceCommand('').intent).toBe('DESCONHECIDO');
  });
});
