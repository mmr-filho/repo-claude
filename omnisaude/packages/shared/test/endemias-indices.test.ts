import { describe, expect, it } from 'vitest';
import { classeIip, conferirVisitaVetorial, indicesDaContagem, indicesLarvarios, positividadeAtividade, type AtividadeVetorial, type VisitaParaIndice, type VisitaVetorialCampo } from '../src/endemias';

/** Imóvel trabalhado no levantamento, com ou sem foco no A2. */
const casa = (id: string, comFoco: number, atividade: AtividadeVetorial = 'LI_T'): VisitaParaIndice => ({
  imovelId: id,
  atividade,
  situacao: 'TRABALHADO',
  depositos: { A2: { inspecionados: Math.max(1, comFoco), comFoco, eliminados: 0, tratados: 0 } },
});
/** n imóveis do levantamento, os primeiros `focos` com foco. */
const lote = (n: number, focos: number) => Array.from({ length: n }, (_, k) => casa(String(k), k < focos ? 1 : 0));

describe('endemias: índices larvários do levantamento (LI e LI+T)', () => {
  it('classe pela razão exata, sem arredondar: 1/101 (0,99%) é satisfatório e 4/101 (3,96%) é alerta', () => {
    expect(indicesLarvarios(lote(101, 1))).toMatchObject({ imoveisInspecionados: 101, imoveisComFoco: 1, iip: 0.99, classe: 'SATISFATORIO' });
    expect(indicesLarvarios(lote(105, 1))).toMatchObject({ iip: 0.95, classe: 'SATISFATORIO' });
    expect(indicesLarvarios(lote(101, 4))).toMatchObject({ iip: 3.96, classe: 'ALERTA' });
    expect(indicesLarvarios(lote(256, 10))).toMatchObject({ iip: 3.91, classe: 'ALERTA' });
    // Nos limites exatos.
    expect(indicesLarvarios(lote(100, 1))).toMatchObject({ iip: 1, classe: 'ALERTA' });
    expect(indicesLarvarios(lote(100, 4))).toMatchObject({ iip: 4, classe: 'RISCO' });
    expect(indicesLarvarios(lote(50, 0))).toMatchObject({ iip: 0, classe: 'SATISFATORIO' });
    expect(indicesLarvarios([])).toMatchObject({ imoveisInspecionados: 0, iip: null, ib: null, ir: null, classe: null });
  });

  it('exatamente 1% é alerta e 4% é risco em qualquer tamanho; o IIP exibido não passa do limite da classe', () => {
    for (const n of [100, 300, 700, 1100, 2900]) {
      expect(classeIip(n / 100, n)).toBe('ALERTA');
      expect(classeIip((4 * n) / 100, n)).toBe('RISCO');
      expect(classeIip(n / 100 - 1, n)).toBe('SATISFATORIO');
    }
    expect(classeIip(0, 0)).toBeNull();
    // 2/201 = 0,995%: arredondado daria 1,00% ao lado de "satisfatório"; aparece 0,99%.
    expect(indicesLarvarios(lote(201, 2))).toMatchObject({ iip: 0.99, classe: 'SATISFATORIO' });
    // 799/20.000 = 3,995%: aparece 3,99%, alerta.
    expect(indicesDaContagem({ imoveisInspecionados: 20_000, imoveisComFoco: 799, depositosInspecionados: 0, depositosComFoco: 0, focoPorTipo: {} })).toMatchObject({ iip: 3.99, classe: 'ALERTA' });
  });

  it('IIP, Breteau, IR e ITR com duas casas', () => {
    const i = indicesLarvarios([
      casa('a', 1),
      casa('b', 0),
      casa('c', 0),
      { imovelId: 'd', atividade: 'LI', situacao: 'TRABALHADO', depositos: { C: { inspecionados: 4, comFoco: 0, eliminados: 0, tratados: 0 }, D1: { inspecionados: 2, comFoco: 2, eliminados: 2, tratados: 0 } } },
    ]);
    // 2 imóveis com foco em 4; 3 depósitos com foco em 4 imóveis; 3 com foco em 9 inspecionados; ITR 1/3 e 2/3.
    expect(i).toMatchObject({ imoveisInspecionados: 4, imoveisComFoco: 2, depositosInspecionados: 9, depositosComFoco: 3, iip: 50, ib: 75, ir: 33.33, classe: 'RISCO' });
    expect(i.itr).toMatchObject({ A2: 33.33, D1: 66.67, C: 0, E: 0 });
    expect(indicesLarvarios(lote(3, 1)).iip).toBe(33.33);
  });

  it('só LI e LI+T entram: PE e bloqueio ficam de fora, e a visita de bloqueio depois não apaga o foco do LI+T', () => {
    // Três LI+T sem foco e um PE com foco no mesmo dia: o IIP do levantamento é 0%.
    const pe: VisitaParaIndice = { imovelId: 'pe', atividade: 'PE', situacao: 'TRABALHADO', depositos: { C: { inspecionados: 2, comFoco: 1, eliminados: 1, tratados: 0 } } };
    expect(indicesLarvarios([casa('a', 0), casa('b', 0), casa('c', 0), pe])).toMatchObject({ imoveisInspecionados: 3, imoveisComFoco: 0, iip: 0, classe: 'SATISFATORIO' });
    // LI+T com foco às 9h e bloqueio sem foco às 15h no mesmo imóvel: o foco do levantamento fica.
    const bloqueio: VisitaParaIndice = { imovelId: 'h', atividade: 'BLOQUEIO', situacao: 'TRABALHADO', depositos: { A2: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 0 } } };
    expect(indicesLarvarios([casa('h', 1), bloqueio])).toMatchObject({ imoveisInspecionados: 1, imoveisComFoco: 1, iip: 100, classe: 'RISCO' });
    for (const atividade of ['T', 'BLOQUEIO', 'PE', 'DF', 'PVE'] as const) expect(indicesLarvarios([casa('x', 1, atividade)]).imoveisInspecionados).toBe(0);
    // Entre as visitas do levantamento, vale a última trabalhada (a pendência depois não conta).
    expect(indicesLarvarios([casa('h', 1, 'LI_T'), casa('h', 0, 'LI')]).imoveisComFoco).toBe(0);
    expect(indicesLarvarios([casa('h', 1, 'LI_T'), { imovelId: 'h', atividade: 'LI', situacao: 'FECHADO' }]).imoveisComFoco).toBe(1);
  });

  it('positividade das outras atividades: rótulo, contagem e percentual com duas casas', () => {
    expect(positividadeAtividade('PE', 3, 1)).toEqual({ atividade: 'PE', label: 'Ponto estratégico', imoveisInspecionados: 3, imoveisComFoco: 1, percentual: 33.33 });
    expect(positividadeAtividade('BLOQUEIO', 0, 0)).toEqual({ atividade: 'BLOQUEIO', label: 'Bloqueio de transmissão', imoveisInspecionados: 0, imoveisComFoco: 0, percentual: null });
  });
});

describe('endemias: depósito D2 (lixo, sucata e entulho)', () => {
  const visita = (tratados: number): VisitaVetorialCampo => ({
    atividade: 'PE',
    situacao: 'TRABALHADO',
    depositos: { D2: { inspecionados: 3, comFoco: 1, eliminados: 0, tratados } },
    tratamentos: tratados ? [{ produtoId: 'x', loteId: 'l', quantidade: 1, depositos: tratados }] : [],
  });

  it('fora do ponto estratégico, a mensagem manda eliminar: lixo e entulho não recebem larvicida, só a sucata de PE', () => {
    const erros = conferirVisitaVetorial(visita(3));
    expect(erros).toContain('Depósito D2: elimine; lixo e entulho não recebem larvicida — só a sucata de ponto estratégico pode ser tratada');
    expect(erros.join()).not.toMatch(/só recebe larvicida em ponto estratégico/);
  });

  it('no ponto estratégico o D2 tratado (a sucata) passa; eliminar sempre passa', () => {
    expect(conferirVisitaVetorial(visita(3), { pontoEstrategico: true })).toEqual([]);
    expect(conferirVisitaVetorial(visita(0))).toEqual([]);
  });
});
