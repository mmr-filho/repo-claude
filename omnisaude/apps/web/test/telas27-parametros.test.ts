import { describe, expect, it } from 'vitest';
import { corpoParametros, errosParametros, formParametros, textoDoPrazo, type ConfiguracoesDaVigilancia } from '../src/components/consolidacao/parametros-regras';

/*
 * Ponto K3: os parâmetros da semana 27 (prazo e meta da negativa, janelas da grade, semanas incompletas, validade da
 * prévia e dias do evento inusitado) agora se editam na tela. Os limites são os do zod do PATCH
 * /vigilancia/configuracoes, e o corpo vai campo a campo (o que não mudou não vai).
 */

const CFG: ConfiguracoesDaVigilancia = {
  negativa: { prazoDiaSemana: 1, prazoHora: '14:00', contaAtrasada: true, metaPercentual: 80, semanasSilenciosa: 2, semanasSoNegativa: 12, semanasRegularidadeMunicipal: 8, semanasAtesto: 8 },
  consolidacao: { semanasIncompletas: 2, expiraPreviaHoras: 24 },
  surto: { diasInusitado: 365 },
};

describe('parâmetros da vigilância (K3)', () => {
  it('sem mudança, nada a gravar', () => {
    const f = formParametros(CFG);
    expect(errosParametros(f)).toEqual([]);
    expect(corpoParametros(CFG, f)).toBeNull();
  });

  it('manda só os campos mudados, bloco a bloco', () => {
    const f = { ...formParametros(CFG), prazoDiaSemana: '2', prazoHora: '09:30', metaPercentual: '90' };
    expect(corpoParametros(CFG, f)).toEqual({ negativa: { prazoDiaSemana: 2, metaPercentual: 90, prazoHora: '09:30' } });
    const g = { ...formParametros(CFG), contaAtrasada: false, semanasIncompletas: '0', diasInusitado: '730' };
    expect(corpoParametros(CFG, g)).toEqual({ negativa: { contaAtrasada: false }, consolidacao: { semanasIncompletas: 0 }, surto: { diasInusitado: 730 } });
  });

  it('confere os limites da API antes de gravar', () => {
    const f = { ...formParametros(CFG), metaPercentual: '0', semanasSilenciosa: '53', semanasIncompletas: '9', expiraPreviaHoras: '169', diasInusitado: '29', prazoHora: '7:00' };
    expect(errosParametros(f)).toEqual([
      'Meta de unidades com informação (%): número inteiro de 1 a 100.',
      'Semanas para a unidade ser silenciosa: número inteiro de 1 a 52.',
      'Semanas incompletas: número inteiro de 0 a 8.',
      'Validade da prévia (horas): número inteiro de 1 a 168.',
      'Dias sem caso para o evento inusitado: número inteiro de 30 a 3.650.',
      'Hora do prazo: HH:MM, de 00:00 a 23:59.',
    ]);
    expect(corpoParametros(CFG, f)).toBeNull();
    expect(errosParametros({ ...formParametros(CFG), semanasAtesto: '2,5' })).toEqual(['Semanas que ainda se pode atestar: número inteiro de 1 a 52.']);
    expect(errosParametros({ ...formParametros(CFG), prazoHora: '24:00' })).toEqual(['Hora do prazo: HH:MM, de 00:00 a 23:59.']);
  });

  it('o prazo configurado em texto', () => {
    expect(textoDoPrazo(formParametros(CFG))).toBe('segunda-feira às 14:00 da semana seguinte à SE atestada (fuso da instituição)');
    expect(textoDoPrazo({ prazoDiaSemana: '0', prazoHora: '08:00' })).toBe('domingo às 08:00 da semana seguinte à SE atestada (fuso da instituição)');
    expect(textoDoPrazo({ prazoDiaSemana: '1', prazoHora: '8h' })).toBeNull();
  });
});
