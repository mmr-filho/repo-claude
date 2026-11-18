import { describe, expect, it } from 'vitest';
import { detectarAglomerados, REGRAS_SURTO_PADRAO, type CasoParaSurto, type OpcoesDeteccaoSurto } from '@omnisaude/shared';

/*
 * Surto (VIG-1c), quarta rodada da semana 27 (SURTO-2): o evento inusitado de todos os agravos é avaliado pela consulta
 * agregada da API, e as notificações dos agravos que podem ser inusitados são lidas à parte. A notificação lida só para
 * o evento inusitado (`soInusitado`), que ficou de fora da leitura das regras de vizinhança (com teto), não entra nas
 * regras de quarteirão, bairro e unidade, como diz o aviso do teto; no evento inusitado, conta.
 */

let seq = 0;
function caso(grupo: string, inicioSintomas: string, extra: Partial<CasoParaSurto> = {}): CasoParaSurto {
  seq++;
  return {
    id: `r4-${seq}`,
    numero: `2026/${String(seq).padStart(5, '0')}`,
    grupo,
    conhecidoEm: `${inicioSintomas}T15:00:00.000Z`,
    inicioSintomas,
    blockId: 'q1',
    neighborhoodId: 'b1',
    unitId: 'hospital',
    unidadeHospitalar: true,
    jaEmSurto: false,
    ...extra,
  };
}
const OPCOES: OpcoesDeteccaoSurto = { hoje: '2026-11-10', fuso: 'America/Sao_Paulo', dispensas: [], diasInusitado: 365, historicoPorGrupo: {} };
const regras = (casos: CasoParaSurto[], opcoes: Partial<OpcoesDeteccaoSurto> = {}) =>
  detectarAglomerados(casos, REGRAS_SURTO_PADRAO, { ...OPCOES, ...opcoes })
    .map((s) => `${s.regra}:${s.casos.length}`)
    .sort();

describe('surto: o caso lido só para o evento inusitado (SURTO-2, quarta rodada)', () => {
  it('fica fora das regras de quarteirão, bairro e unidade, e conta no evento inusitado', () => {
    // Dois casos de cólera no mesmo quarteirão, bairro e hospital: lidos pelas regras, viram quarteirão e bairro.
    const lidos = [caso('colera', '2026-11-05'), caso('colera', '2026-11-06')];
    expect(regras(lidos, { historicoPorGrupo: { colera: null } })).toEqual(['bairro-7d:2', 'inusitado:2', 'quarteirao-7d:2']);
    // Os mesmos casos, cortados da leitura das regras de vizinhança e lidos só para o inusitado: só o inusitado.
    const soInusitado = lidos.map((c) => ({ ...c, soInusitado: true }));
    // Antes: a marca não existia, e as regras de vizinhança usavam o caso que o teto tinha deixado de fora.
    expect(regras(soInusitado, { historicoPorGrupo: { colera: null } })).toEqual(['inusitado:2']);
    // Varicela em hospital: um caso basta para a regra da unidade, mas não o lido só para o inusitado.
    const varicela = caso('varicela', '2026-11-08', { soInusitado: true });
    expect(regras([varicela])).toEqual([]);
    expect(regras([{ ...varicela, soInusitado: false }])).toEqual(['varicela-hospitalar:1']);
  });

  it('o grupo fora do histórico não é avaliado no evento inusitado, mesmo com casos lidos', () => {
    // A API passa só os grupos que podem ser inusitados: o grupo com os primeiros casos da janela cortados da leitura das
    // regras de vizinhança não vira "primeiro caso" pelos casos mais recentes.
    expect(regras([caso('febre-tifoide', '2026-11-09', { blockId: null, neighborhoodId: null })])).toEqual([]);
    expect(regras([caso('febre-tifoide', '2026-11-09', { blockId: null, neighborhoodId: null })], { historicoPorGrupo: { 'febre-tifoide': null } })).toEqual(['inusitado:1']);
  });
});
