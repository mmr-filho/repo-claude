import { describe, expect, it } from 'vitest';
import { codigoAcessoDe, eventoIcs, mascararTelefone, podeCancelarAgendamento, podeConfirmarAgendamento, posologia, usoContinuo } from '../src/cidadao';

describe('App do cidadão: utilitários', () => {
  it('mascara o telefone e deixa o DDD e os quatro últimos dígitos', () => {
    expect(mascararTelefone('(63) 99999-0001')).toBe('(63) *****-0001');
    expect(mascararTelefone('6333120000')).toBe('(63) ****-0000');
    expect(mascararTelefone('123')).toBeNull();
    expect(mascararTelefone(null)).toBeNull();
  });
  it('cancela e confirma só agendamentos futuros em aberto', () => {
    const agora = new Date('2026-10-31T12:00:00Z');
    expect(podeCancelarAgendamento('AGENDADO', '2026-11-02T12:00:00Z', agora)).toBe(true);
    expect(podeCancelarAgendamento('CONFIRMADO', '2026-11-02T12:00:00Z', agora)).toBe(true);
    expect(podeCancelarAgendamento('AGENDADO', '2026-10-30T12:00:00Z', agora)).toBe(false);
    expect(podeCancelarAgendamento('ATENDIDO', '2026-11-02T12:00:00Z', agora)).toBe(false);
    expect(podeConfirmarAgendamento('CONFIRMADO', '2026-11-02T12:00:00Z', agora)).toBe(false);
    expect(podeConfirmarAgendamento('AGENDADO', '2026-11-02T12:00:00Z', agora)).toBe(true);
  });
  it('classifica uso contínuo e descreve a posologia', () => {
    expect(usoContinuo({ durationDays: null })).toBe(true);
    expect(usoContinuo({ durationDays: 90 })).toBe(true);
    expect(usoContinuo({ durationDays: 7 })).toBe(false);
    expect(posologia({ dose: '1', doseUnit: 'comprimido', frequencyHours: 12, durationDays: 30 })).toBe('1 comprimido · a cada 12 h · por 30 dias');
    expect(posologia({ dose: 2, doseUnit: 'mL', frequencyHours: 24, instructions: 'em jejum' })).toBe('2 mL · 1 vez ao dia · uso contínuo · em jejum');
    expect(posologia({ frequencyHours: 48 })).toBe('a cada 2 dias · uso contínuo');
  });
  it('gera código de 6 dígitos e um .ics válido', () => {
    expect(codigoAcessoDe(new Uint8Array([0, 0, 0, 7]))).toBe('000007');
    expect(codigoAcessoDe(new Uint8Array([255, 255, 255, 255]))).toMatch(/^\d{6}$/);
    const ics = eventoIcs({ uid: 'x1', inicio: '2026-11-05T11:00:00Z', fim: '2026-11-05T11:20:00Z', titulo: 'Consulta, cardiologia', local: 'Policlínica' });
    expect(ics).toContain('DTSTART:20261105T110000Z');
    expect(ics).toContain('SUMMARY:Consulta\\, cardiologia');
    expect(ics).toContain('LOCATION:Policlínica');
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });
});
