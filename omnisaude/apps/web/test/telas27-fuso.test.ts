import type { SemanaParaAtestar } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import { descricaoDaCelula, textoDaSemanaDoResponsavel } from '../src/components/consolidacao/negativa-regras';
import { textoSurtoNotificado, tituloPrazoSurto } from '../src/components/consolidacao/surto-regras';
import { fmtDateTime, fmtDateTimeTz, fmtDateTz } from '../src/lib/format';

/*
 * Achado tel-1: as telas da semana 27 calculam e gravam no fuso da instituição (tenant.timeZone), mas mostravam os
 * instantes no fuso fixo de São Paulo. Numa instituição em Manaus (UTC−4), o prazo da negativa segunda às 14:00
 * aparecia como 15:00, e o "Vence em" do surto 1 h depois do vencimento real.
 */

const MANAUS = 'America/Manaus';
const SP = 'America/Sao_Paulo';
/** Segunda, 16/11/2026, 14:00 em Manaus (UTC−4) = 15:00 em São Paulo (UTC−3). */
const PRAZO_MANAUS = '2026-11-16T18:00:00.000Z';

describe('formatador com o fuso da instituição', () => {
  it('formata no fuso informado; o fmtDateTime das outras telas segue no de São Paulo', () => {
    expect(fmtDateTimeTz(PRAZO_MANAUS, MANAUS)).toBe('16/11/2026, 14:00');
    expect(fmtDateTimeTz(PRAZO_MANAUS, SP)).toBe('16/11/2026, 15:00');
    expect(fmtDateTime(PRAZO_MANAUS)).toBe('16/11/2026, 15:00');
    // Sem fuso, ou com um fuso que o Intl não conhece, vale o de São Paulo.
    expect(fmtDateTimeTz(PRAZO_MANAUS, null)).toBe('16/11/2026, 15:00');
    expect(fmtDateTimeTz(PRAZO_MANAUS, 'Fuso/Inexistente')).toBe('16/11/2026, 15:00');
    expect(fmtDateTimeTz(null, MANAUS)).toBe('—');
    expect(fmtDateTimeTz('não é data', MANAUS)).toBe('—');
  });

  it('a data de um instante perto da meia-noite sai no dia da instituição; a data civil não muda', () => {
    // 23:30 de 10/11 em Manaus = 00:30 de 11/11 em São Paulo.
    expect(fmtDateTz('2026-11-11T03:30:00.000Z', MANAUS)).toBe('10/11/2026');
    expect(fmtDateTz('2026-11-11T03:30:00.000Z', SP)).toBe('11/11/2026');
    expect(fmtDateTz('2026-11-10', MANAUS)).toBe('10/11/2026');
    expect(fmtDateTz(undefined, MANAUS)).toBe('—');
  });
});

describe('notificação negativa no fuso da instituição', () => {
  const semana = (o: Partial<SemanaParaAtestar>): Pick<SemanaParaAtestar, 'atesto' | 'prazo' | 'prazoPassou' | 'podeAtestar'> => ({ atesto: null, prazo: PRAZO_MANAUS, prazoPassou: false, podeAtestar: true, ...o });

  it('o prazo do atesto aparece na hora em que a API o calcula (e o PDF o mostra)', () => {
    expect(textoDaSemanaDoResponsavel(semana({}), MANAUS)).toBe('Prazo: 16/11/2026, 14:00.');
    expect(textoDaSemanaDoResponsavel(semana({ prazoPassou: true }), MANAUS)).toBe('Prazo vencido em 16/11/2026, 14:00: o atesto ainda é aceito e fica marcado como fora do prazo.');
    expect(textoDaSemanaDoResponsavel(semana({ prazoPassou: true, podeAtestar: false }), MANAUS)).toBe('Prazo vencido em 16/11/2026, 14:00.');
  });

  it('o atesto feito mostra a hora local, no prazo ou fora dele', () => {
    const atesto = {
      id: 'a1',
      unitId: 'u1',
      unidade: 'UBS Centro',
      cnes: '1234567',
      semana: '202646',
      status: 'ATESTADA' as const,
      atestadoEm: '2026-11-16T18:30:00.000Z',
      atestadoPor: 'Ana',
      funcao: null,
      emNome: false,
      motivoEmNome: null,
      atrasado: true,
      declaracao: '',
      canceladoEm: null,
      motivoCancelamento: null,
      causa: null,
      registroOficialId: null,
    };
    expect(textoDaSemanaDoResponsavel(semana({ atesto }), MANAUS)).toBe('Atestada em 16/11/2026, 14:30 por Ana, fora do prazo.');
  });

  it('o detalhe da célula da grade traz o prazo no fuso da instituição', () => {
    const coluna = { semana: '202646', inicio: '2026-11-08', fim: '2026-11-14', prazo: PRAZO_MANAUS };
    expect(descricaoDaCelula({ unidade: { id: 'u1', nome: 'UBS Centro', cnes: '1234567' } }, coluna, MANAUS)).toBe('CNES 1234567 · de 08/11 a 14/11 · prazo do atesto: 16/11/2026, 14:00');
  });
});

describe('surto no fuso da instituição', () => {
  it('o vencimento e o cumprimento da comunicação saem na hora local', () => {
    // Conhecido às 10:00 de Manaus (14:00 UTC): vence às 10:00 do dia seguinte, não às 11:00.
    expect(tituloPrazoSurto({ cumpridoEm: null, venceEm: '2026-11-11T14:00:00.000Z' }, MANAUS)).toBe('Vence em 11/11/2026, 10:00');
    expect(tituloPrazoSurto({ cumpridoEm: '2026-11-10T15:15:00.000Z', venceEm: '2026-11-11T14:00:00.000Z' }, MANAUS)).toBe('Cumprido em 10/11/2026, 11:15');
    expect(textoSurtoNotificado({ numero: '2026/0003', venceEm: '2026-11-11T14:00:00.000Z' }, MANAUS)).toBe('Surto 2026/0003 notificado. Prazo da comunicação à SMS: 11/11/2026, 10:00.');
  });
});
