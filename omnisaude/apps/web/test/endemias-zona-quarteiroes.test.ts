import { describe, expect, it } from 'vitest';
import { opcoesQuarteiraoZona, rotuloQuarteiroesZona } from '../src/components/endemias/gestao-regras';

/*
 * Diálogo da zona (telas da supervisão): o quarteirão desativado na malha que continua na zona aparece marcado, como no
 * cadastro do imóvel. A API devolve ativo:false em GET /endemias/zonas e aceita salvar a zona com ele (só o quarteirão que
 * entra é conferido).
 */

const daZona = [
  { id: 'q-12', numero: '12', ativo: true },
  { id: 'q-13', numero: '13', ativo: false },
];
const livres = [
  { id: 'q-40', numero: '40', localidade: 'Sede', bairro: 'Centro' },
  { id: 'q-41', numero: '41', localidade: 'Vila Nova', bairro: null },
];

describe('quarteirões no diálogo da zona', () => {
  it('o desativado na malha que continua na zona vem marcado; os ativos e os livres, não', () => {
    expect(opcoesQuarteiraoZona(daZona, livres, '')).toEqual([
      { id: 'q-12', numero: '12', localidade: null, rotulo: 'Q 12' },
      { id: 'q-13', numero: '13', localidade: null, rotulo: 'Q 13 (desativado na malha)' },
      { id: 'q-40', numero: '40', localidade: 'Sede', rotulo: 'Q 40' },
      { id: 'q-41', numero: '41', localidade: 'Vila Nova', rotulo: 'Q 41' },
    ]);
  });

  it('o filtro vale para os da zona e os livres (número, localidade ou bairro), e o desativado continua marcado', () => {
    expect(opcoesQuarteiraoZona(daZona, livres, ' 13 ').map((q) => q.rotulo)).toEqual(['Q 13 (desativado na malha)']);
    expect(opcoesQuarteiraoZona(daZona, livres, 'centro').map((q) => q.id)).toEqual(['q-40']);
    expect(opcoesQuarteiraoZona(daZona, livres, 'VILA').map((q) => q.id)).toEqual(['q-41']);
    expect(opcoesQuarteiraoZona(daZona, livres, 'q-99')).toEqual([]);
  });

  it('zona nova (sem quarteirões) mostra só os livres; o livre que já está nesta zona aparece uma vez, como da zona', () => {
    expect(opcoesQuarteiraoZona([], livres, '').map((q) => q.rotulo)).toEqual(['Q 40', 'Q 41']);
    // Lista de livres lida depois de outra edição da zona: a caixa não se repete.
    expect(opcoesQuarteiraoZona([{ id: 'q-40', numero: '40', ativo: true }], livres, '').map((q) => q.id)).toEqual(['q-40', 'q-41']);
  });
});

describe('quarteirões na tabela das zonas', () => {
  it('em ordem numérica, com o desativado na malha marcado como no diálogo', () => {
    expect(
      rotuloQuarteiroesZona([
        { numero: '13', ativo: false },
        { numero: '2', ativo: true },
        { numero: '12', ativo: true },
      ]),
    ).toBe('2, 12, 13 (desativado na malha)');
  });

  it('zona sem quarteirões mostra o travessão', () => {
    expect(rotuloQuarteiroesZona([])).toBe('—');
  });
});
