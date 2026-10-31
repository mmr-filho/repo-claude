import { describe, expect, it } from 'vitest';
import {
  competenciaRegulacao,
  consumirCotas,
  diasEmFila,
  escolherCota,
  ESPECIALIDADES,
  numeroProtocolo,
  ordenarFila,
  prazoMeta,
  PRIORIDADES,
  prioridadeSugerida,
  PROCEDIMENTOS_REGULADOS,
  tempoMedioDias,
  verificarProtocolo,
} from '../src/regulacao';
import { roleHasPermission } from '../src/roles';

const hoje = new Date('2026-10-31T12:00:00Z');
const dias = (n: number) => new Date(hoje.getTime() - n * 86_400_000);

describe('regulação ambulatorial: protocolos, prioridade e fila única', () => {
  it('tem protocolos por especialidade e procedimentos regulados sem códigos repetidos', () => {
    expect(ESPECIALIDADES.length).toBeGreaterThanOrEqual(12);
    const codigos = ESPECIALIDADES.map((e) => e.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const e of ESPECIALIDADES) {
      expect(e.criterios.length).toBeGreaterThan(0);
      expect(new Set(e.criterios.map((c) => c.codigo)).size).toBe(e.criterios.length);
      expect(e.sigtapCode).toMatch(/^\d{10}$/);
    }
    for (const p of PROCEDIMENTOS_REGULADOS) expect(p.sigtapCode).toMatch(/^\d{10}$/);
    expect(PROCEDIMENTOS_REGULADOS.find((p) => p.codigo === 'MAMOGRAFIA')?.criterios.map((c) => c.prioridade)).toEqual(['AZUL', 'AMARELA', 'VERDE']);
  });

  it('sugere a prioridade pelo critério mais grave marcado', () => {
    const cardio = ESPECIALIDADES.find((e) => e.codigo === 'CARDIOLOGIA')!;
    expect(prioridadeSugerida(cardio.criterios, [])).toBe('AZUL');
    expect(prioridadeSugerida(cardio.criterios, ['HAS_RESISTENTE'])).toBe('VERDE');
    expect(prioridadeSugerida(cardio.criterios, ['HAS_RESISTENTE', 'IC_DESCOMPENSADA'])).toBe('AMARELA');
    expect(prioridadeSugerida(cardio.criterios, ['ESTRATIFICACAO_ALTO_RISCO', 'ANGINA_INSTAVEL'])).toBe('VERMELHA');
    expect(PRIORIDADES.VERMELHA.exigeJustificativa).toBe(true);
    expect(PRIORIDADES.VERDE.exigeJustificativa).toBe(false);
  });

  it('confere o protocolo: exames mínimos dos últimos 12 meses, critério e justificativa', () => {
    const semNada = verificarProtocolo({ tipo: 'CONSULTA', codigo: 'CARDIOLOGIA', criterios: [], prioridade: 'AMARELA' }, [], hoje);
    expect(semNada.examesFaltantes.map((e) => e.nome)).toEqual(['Eletrocardiograma', 'Creatinina']);
    expect(semNada.semCriterio).toBe(true);
    expect(semNada.semJustificativa).toBe(true);
    expect(semNada.pendencias).toHaveLength(4);
    const completa = verificarProtocolo(
      { tipo: 'CONSULTA', codigo: 'CARDIOLOGIA', criterios: ['HAS_RESISTENTE'], prioridade: 'VERDE' },
      [
        { sigtapCode: '0211020036', at: dias(30) },
        { analito: 'CREATININA', at: dias(400) },
        { analito: 'CREATININA', at: dias(10) },
      ],
      hoje,
    );
    expect(completa.pendencias).toEqual([]);
    expect(completa.examesRecomendados.map((e) => e.nome)).toEqual(['Radiografia de tórax', 'Potássio']);
    const velho = verificarProtocolo(
      { tipo: 'CONSULTA', codigo: 'CARDIOLOGIA', criterios: ['HAS_RESISTENTE'], prioridade: 'VERDE' },
      [
        { sigtapCode: '0211020036', at: dias(400) },
        { analito: 'CREATININA', at: dias(10) },
      ],
      hoje,
    );
    expect(velho.pendencias).toEqual(['Sem Eletrocardiograma nos últimos 12 meses']);
    // Exames regulados não têm exames mínimos, mas pedem critério.
    const mamo = verificarProtocolo({ tipo: 'EXAME', codigo: 'MAMOGRAFIA', criterios: ['RASTREIO_50_69'], prioridade: 'AZUL' }, [], hoje);
    expect(mamo.pendencias).toEqual([]);
  });

  it('ordena a fila única por prioridade e, dentro dela, por ordem de chegada; calcula prazo-meta e dias', () => {
    const fila = ordenarFila([
      { id: 'c', prioridade: 'AZUL', createdAt: dias(40) },
      { id: 'a', prioridade: 'VERDE', createdAt: dias(2) },
      { id: 'b', prioridade: 'VERDE', createdAt: dias(20) },
      { id: 'd', prioridade: 'VERMELHA', createdAt: dias(0) },
    ]);
    expect(fila.map((f) => f.id)).toEqual(['d', 'b', 'a', 'c']);
    expect(prazoMeta('AMARELA', dias(3)).toISOString().slice(0, 10)).toBe(dias(-4).toISOString().slice(0, 10));
    expect(diasEmFila(dias(20), hoje)).toBe(20);
    expect(numeroProtocolo(2026, 7)).toBe('REG-2026-000007');
  });

  it('médico e enfermagem solicitam; NIR e gestão regulam; recepção só acompanha', () => {
    expect(roleHasPermission('MEDICO', 'regulacao.solicitar')).toBe(true);
    expect(roleHasPermission('ENFERMAGEM', 'regulacao.solicitar')).toBe(true);
    expect(roleHasPermission('MEDICO', 'regulacao.regular')).toBe(false);
    expect(roleHasPermission('NIR', 'regulacao.regular')).toBe(true);
    expect(roleHasPermission('GESTOR', 'regulacao.regular')).toBe(true);
    expect(roleHasPermission('RECEPCAO', 'regulacao.ler')).toBe(true);
    expect(roleHasPermission('RECEPCAO', 'regulacao.solicitar')).toBe(false);
  });

  it('cotas: consumo por solicitação autorizada, escolha da cota da unidade antes da geral e esgotamento', () => {
    const cotas = [
      { id: 'geral', providerId: 'p1', competencia: '2026-10', kind: 'CONSULTA' as const, specialty: 'CARDIOLOGIA', quantity: 2, unitValue: 10 },
      { id: 'ubs', providerId: 'p1', competencia: '2026-10', kind: 'CONSULTA' as const, specialty: 'CARDIOLOGIA', quantity: 1, unitValue: 10, originUnitId: 'u1' },
    ];
    const consumo = consumirCotas(cotas, [{ quotaId: 'geral' }, { quotaId: null }, { quotaId: 'ubs' }]);
    expect(consumo.map((c) => [c.id, c.used, c.available, c.valorUsado])).toEqual([
      ['geral', 1, 1, 10],
      ['ubs', 1, 0, 10],
    ]);
    expect(escolherCota(consumo, 'u1')?.id).toBe('geral');
    expect(escolherCota(consumirCotas(cotas, []), 'u1')?.id).toBe('ubs');
    expect(escolherCota(consumirCotas(cotas, []), 'u2')?.id).toBe('geral');
    expect(escolherCota(consumirCotas(cotas, [{ quotaId: 'geral' }, { quotaId: 'geral' }, { quotaId: 'ubs' }]), 'u1')).toBeNull();
    expect(competenciaRegulacao(new Date('2026-11-01T01:00:00Z'), 'America/Sao_Paulo')).toBe('2026-10');
    expect(
      tempoMedioDias([
        { inicio: dias(10), fim: dias(2) },
        { inicio: dias(5), fim: dias(0) },
      ]),
    ).toBe(6.5);
    expect(tempoMedioDias([])).toBeNull();
  });
});
