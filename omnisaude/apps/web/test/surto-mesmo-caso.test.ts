import type { CasoSurto, DetalheSurto } from '@omnisaude/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * Planilha do surto com o mesmo caso em duas linhas (SURTO-5 e N6, quarta rodada da semana 27): a notificação de uma
 * linha e o registro oficial conciliado com ela na outra (vínculo feito depois). As duas linhas ficam, marcadas com o
 * NU_CASO da outra, até a vigilância retirar uma; o título conta o caso uma vez (`casosNaPlanilha`). A planilha é
 * renderizada no servidor, com a API e a sessão simuladas.
 */

vi.mock('@/lib/hooks', () => ({ useApi: () => ({ data: null, error: null, loading: false, reload: async () => {}, setData: () => {} }) }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ me: { tenant: { timeZone: 'America/Sao_Paulo' } }, can: () => true }) }));

const { SurtoPlanilha } = await import('../src/components/consolidacao/surto-planilha');

const linha = (numero: number, o: Partial<CasoSurto>): CasoSurto => ({
  id: `c${numero}`,
  numero,
  notificationId: null,
  notificacaoNumero: null,
  officialRecordId: null,
  iniciais: 'RLD',
  sexo: 'F',
  idade: '34 anos',
  municipioResidencia: '3550308',
  bairroId: null,
  bairroNome: null,
  inicioSintomas: '2026-11-07',
  hospitalizado: null,
  obito: null,
  classificacao: null,
  criterio: null,
  cidFinal: null,
  semNotificacaoIndividual: false,
  mesmoCasoQue: null,
  restrito: false,
  ...o,
});
const detalhe = (planilha: CasoSurto[], casosNaPlanilha: number) =>
  ({ id: 's1', casos: 30, casosNaPlanilha, planilha, permissoes: { editar: true, encerrar: true, descartar: true, numeroOficial: true } }) as unknown as DetalheSurto;
const html = (d: DetalheSurto) => renderToStaticMarkup(createElement(SurtoPlanilha, { d, onMudou: () => {} }));

describe('planilha do surto com o mesmo caso em duas linhas', () => {
  it('as duas linhas vêm marcadas com o NU_CASO da outra, e o título conta o caso uma vez', () => {
    const h = html(
      detalhe(
        [
          linha(1, { notificationId: 'n1', notificacaoNumero: '2026/000101', mesmoCasoQue: 2 }),
          linha(2, { officialRecordId: 'r1', mesmoCasoQue: 1 }),
          // A linha sob sigilo também vem marcada (só o número do caso, como a origem).
          linha(3, { officialRecordId: 'r2', restrito: true, mesmoCasoQue: 4 }),
          linha(4, { notificationId: 'n2', notificacaoNumero: '2026/000102', mesmoCasoQue: 3 }),
          linha(5, { iniciais: 'MNL' }),
        ],
        3,
      ),
    );
    // Antes: "Planilha de casos (5 de 30 informados)", sem marca nenhuma.
    expect(h).toContain('Planilha de casos (3 de 30 informados)');
    expect([...h.matchAll(/Mesmo caso do caso (\d+)/g)].map((m) => Number(m[1]))).toEqual([2, 1, 4, 3]);
  });

  it('sem o par, nenhuma marca', () => {
    const h = html(detalhe([linha(1, { notificationId: 'n1', notificacaoNumero: '2026/000101' }), linha(2, { officialRecordId: 'r1' })], 2));
    expect(h).toContain('Planilha de casos (2 de 30 informados)');
    expect(h).not.toContain('Mesmo caso do caso');
  });
});
