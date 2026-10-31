import { describe, expect, it } from 'vitest';
import { aprazar, CALENDARIO_NACIONAL, proximasDoses } from '../src/vacinas';

const DIA = 86_400_000;
const hoje = new Date('2026-10-31T12:00:00Z');
const dias = (n: number) => new Date(hoje.getTime() - n * DIA);
const nasc = (meses: number) => new Date(hoje.getTime() - meses * 30.4375 * DIA);

describe('calendário nacional e aprazamento', () => {
  it('tem o calendário por grupo com códigos de dose do e-SUS', () => {
    expect(CALENDARIO_NACIONAL.filter((r) => r.grupo === 'CRIANCA' && r.componente === 'DTP').map((r) => [r.meses, r.doseCodigo])).toEqual([
      [2, '1'],
      [4, '2'],
      [6, '3'],
      [15, '6'],
      [48, '7'],
    ]);
    expect(CALENDARIO_NACIONAL.find((r) => r.componente === 'HPV')).toMatchObject({ grupo: 'ADOLESCENTE', meses: 108, idadeMaxMeses: 179, doseCodigo: '9' });
    expect(CALENDARIO_NACIONAL.filter((r) => r.grupo === 'GESTANTE').map((r) => r.componente)).toEqual(['DTPA_ADULTO', 'INFLUENZA']);
  });

  it('criança de 3 meses sem nenhuma dose: BCG e hepatite B atrasadas, doses dos 2 meses atrasadas, as dos 4 meses aprazadas', () => {
    const s = aprazar({ birthDate: nasc(3), sex: 'M' }, [], hoje);
    const por = (comp: string, dose: number) => s.find((x) => x.componente === comp && x.dose === dose)!;
    expect(por('BCG', 1).situacao).toBe('ATRASADA');
    expect(por('HEPB', 1).situacao).toBe('ATRASADA');
    expect(por('DTP', 1)).toMatchObject({ situacao: 'ATRASADA', doseCodigo: '1' });
    expect(por('DTP', 2).situacao).toBe('APRAZADA');
    expect(por('DTP', 2).prevista).toBe(
      nasc(3 - 4)
        .toISOString()
        .slice(0, 10),
    );
    expect(por('MENINGO_C', 1).situacao).toBe('APRAZADA');
    const proximas = proximasDoses(s);
    expect(proximas.filter((p) => p.componente === 'DTP')).toHaveLength(1);
    expect(proximas.find((p) => p.componente === 'DTP')?.dose).toBe(1);
  });

  it('criança de 18 meses que tomou só a 1ª penta hoje: a próxima é a 2ª dose daqui a 30 dias, não a 3ª', () => {
    const s = aprazar({ birthDate: nasc(18), sex: 'M' }, [{ componentes: ['DTP', 'HEPB', 'HIB'], at: hoje }], hoje);
    const dtp = s.filter((x) => x.componente === 'DTP').sort((a, b) => a.dose - b.dose);
    expect(dtp.map((x) => [x.dose, x.situacao])).toEqual([
      [1, 'APLICADA'],
      [2, 'APRAZADA'],
      [3, 'APRAZADA'],
      [4, 'APRAZADA'],
    ]);
    expect(dtp[1]?.prevista).toBe(new Date(hoje.getTime() + 30 * DIA).toISOString().slice(0, 10));
    expect(dtp[2]?.prevista).toBe(new Date(hoje.getTime() + 60 * DIA).toISOString().slice(0, 10));
    expect(proximasDoses(s).find((p) => p.componente === 'DTP')?.dose).toBe(2);
    expect(s.find((x) => x.componente === 'ROTA')).toBeUndefined();
  });

  it('respeita o intervalo mínimo: a 2ª dose da penta vence 30 dias depois da 1ª quando esta atrasou', () => {
    const s = aprazar({ birthDate: nasc(5), sex: 'F' }, [{ componentes: ['DTP', 'HEPB', 'HIB'], at: dias(10) }], hoje);
    const d2 = s.find((x) => x.componente === 'DTP' && x.dose === 2)!;
    expect(d2.situacao).toBe('APRAZADA');
    expect(d2.prevista).toBe(new Date(dias(10).getTime() + 30 * DIA).toISOString().slice(0, 10));
    expect(s.find((x) => x.componente === 'DTP' && x.dose === 1)).toMatchObject({ situacao: 'APLICADA', aplicadaEm: dias(10).toISOString().slice(0, 10) });
  });

  it('tríplice viral: doses antes dos 12 meses não contam e a 2ª dose não é cobrada de quem tem 30 anos ou mais', () => {
    const bebe = aprazar({ birthDate: nasc(14), sex: 'F' }, [{ componentes: ['SCR'], at: nasc(10) }], hoje);
    expect(bebe.find((x) => x.componente === 'SCR' && x.dose === 1)?.situacao).toBe('ATRASADA');
    const adulto = aprazar({ birthDate: nasc(35 * 12), sex: 'M' }, [{ componentes: ['SCR'], at: dias(400) }], hoje);
    expect(adulto.find((x) => x.componente === 'SCR' && x.dose === 1)?.situacao).toBe('APLICADA');
    expect(adulto.find((x) => x.componente === 'SCR' && x.dose === 2)).toBeUndefined();
  });

  it('adulto: dT em 3 doses e depois reforço decenal; hepatite B em 3 doses; idoso tem influenza anual', () => {
    const semNada = aprazar({ birthDate: nasc(40 * 12), sex: 'M' }, [], hoje);
    // Vacinas infantis não são cobradas do adulto sem histórico; febre amarela e tríplice viral sim.
    expect(semNada.map((x) => x.componente)).not.toContain('ROTA');
    expect(semNada.map((x) => x.componente)).not.toContain('DTP');
    expect(semNada.map((x) => x.componente)).not.toContain('BCG');
    expect(semNada.find((x) => x.componente === 'FEBRE_AMARELA')?.situacao).toBe('ATRASADA');
    expect(semNada.find((x) => x.componente === 'DT')).toMatchObject({ situacao: 'ATRASADA', dose: 1 });
    expect(semNada.find((x) => x.componente === 'HEPB' && x.dose === 1)?.situacao).toBe('ATRASADA');
    expect(semNada.find((x) => x.componente === 'INFLUENZA')).toBeUndefined();
    const completo = aprazar(
      { birthDate: nasc(40 * 12), sex: 'M' },
      [
        { componentes: ['DT'], at: dias(3000) },
        { componentes: ['DT'], at: dias(2900) },
        { componentes: ['DT'], at: dias(2700) },
      ],
      hoje,
    );
    const dt = completo.find((x) => x.componente === 'DT')!;
    expect(dt.rotulo).toContain('reforço');
    expect(dt.situacao).toBe('APLICADA');
    expect(dt.prevista).toBe(new Date(dias(2700).getTime() + 120 * 30.4375 * DIA).toISOString().slice(0, 10));
    const idosa = aprazar({ birthDate: nasc(70 * 12), sex: 'F' }, [{ componentes: ['INFLUENZA'], at: dias(400) }], hoje);
    expect(idosa.find((x) => x.componente === 'INFLUENZA')).toMatchObject({ situacao: 'ATRASADA', grupo: 'IDOSO', estrategia: 'CAMPANHA' });
    const idosaEmDia = aprazar({ birthDate: nasc(70 * 12), sex: 'F' }, [{ componentes: ['INFLUENZA'], at: dias(100) }], hoje);
    expect(idosaEmDia.find((x) => x.componente === 'INFLUENZA')?.situacao).toBe('APLICADA');
  });

  it('gestante: dTpa aprazada para a 20ª semana e aplicada quando registrada na gestação', () => {
    const dum = dias(10 * 7);
    const antes = aprazar({ birthDate: nasc(28 * 12), sex: 'F', gestacaoDum: dum }, [], hoje);
    const dtpa = antes.find((x) => x.componente === 'DTPA_ADULTO')!;
    expect(dtpa.situacao).toBe('APRAZADA');
    expect(dtpa.prevista).toBe(new Date(dum.getTime() + 140 * DIA).toISOString().slice(0, 10));
    const depois = aprazar({ birthDate: nasc(28 * 12), sex: 'F', gestacaoDum: dias(30 * 7) }, [{ componentes: ['DTPA_ADULTO'], at: dias(7) }], hoje);
    expect(depois.find((x) => x.componente === 'DTPA_ADULTO')?.situacao).toBe('APLICADA');
    expect(aprazar({ birthDate: nasc(28 * 12), sex: 'F' }, [], hoje).find((x) => x.componente === 'DTPA_ADULTO')).toBeUndefined();
  });
});
