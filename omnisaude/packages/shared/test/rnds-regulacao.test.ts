import { describe, expect, it } from 'vitest';
import { caraterMira, estadoMira, exigeMotivoMira, identificadorDocumentoRegulacao, modalidadeMira, statusMiraAmbulatorial, statusMiraLeito } from '../src/rnds-regulacao';

describe('MIRA: mapeamento das situações', () => {
  it('traduz a regulação ambulatorial para os códigos do MIRA', () => {
    expect(statusMiraAmbulatorial('PENDENTE')).toBe('pending');
    expect(statusMiraAmbulatorial('EM_ANALISE')).toBe('pending');
    expect(statusMiraAmbulatorial('AUTORIZADA')).toBe('pending');
    expect(statusMiraAmbulatorial('AUTORIZADA', 'FALTOU')).toBe('absence');
    expect(statusMiraAmbulatorial('DEVOLVIDA')).toBe('returned-to-requester');
    expect(statusMiraAmbulatorial('AGENDADA')).toBe('booked');
    expect(statusMiraAmbulatorial('REALIZADA')).toBe('attended');
    expect(statusMiraAmbulatorial('NEGADA')).toBe('cancelled');
    expect(statusMiraAmbulatorial('CANCELADA')).toBe('cancelled');
  });
  it('traduz a central de leitos', () => {
    expect(statusMiraLeito('PENDENTE')).toBe('pending');
    expect(statusMiraLeito('DEVOLVIDA')).toBe('returned-to-requester');
    expect(statusMiraLeito('AUTORIZADA')).toBe('booked');
    expect(statusMiraLeito('EM_TRANSFERENCIA')).toBe('booked');
    expect(statusMiraLeito('INTERNADA')).toBe('attended');
    expect(statusMiraLeito('CANCELADA')).toBe('cancelled');
  });
  it('estados FHIR e exigências seguem as invariantes mira-2 a mira-19', () => {
    expect(estadoMira('pending')).toMatchObject({ serviceRequest: 'active', appointment: 'proposed', proibeExecutante: true });
    expect(estadoMira('returned-to-requester')).toMatchObject({ serviceRequest: 'on-hold', appointment: 'waitlist' });
    expect(estadoMira('booked')).toMatchObject({ serviceRequest: 'active', appointment: 'booked', exigeExecutante: true, exigeExecucao: false });
    expect(estadoMira('attended')).toMatchObject({ serviceRequest: 'completed', appointment: 'fulfilled', exigeExecutante: true, exigeExecucao: true });
    expect(estadoMira('absence')).toMatchObject({ serviceRequest: 'completed', appointment: 'noshow', exigeExecucao: true });
    expect(estadoMira('cancelled')).toMatchObject({ serviceRequest: 'revoked', appointment: 'cancelled' });
  });
  it('caráter, modalidade, identificador e exigência do motivo', () => {
    expect(caraterMira('VERMELHA')).toBe('urgent');
    expect(caraterMira('AMARELA')).toBe('urgent');
    expect(caraterMira('VERDE')).toBe('routine');
    expect(modalidadeMira('LEITO')).toBe('04');
    expect(modalidadeMira('AMBULATORIAL')).toBe('09');
    expect(identificadorDocumentoRegulacao('AMBULATORIAL', 'REG-2026-000012', 3)).toBe('AMB_REG-2026-000012_003');
    expect(exigeMotivoMira(new Date('2024-12-31T12:00:00Z'))).toBe(false);
    expect(exigeMotivoMira(new Date('2026-10-31T12:00:00Z'))).toBe(true);
  });
});
