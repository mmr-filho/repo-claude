import type { CasoSurto, DetalheSurto } from '@omnisaude/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * Surto (web), quinta rodada da semana 27. R5-9 (r4vsur-2): o cabeçalho do detalhe ("Casos (informados / na planilha)")
 * e a aba da planilha contam o caso que está em duas linhas uma vez (`casosNaPlanilha`), como a lista e o título da
 * planilha. R5-8 (r4vsur-1): o par em que uma das linhas é sob sigilo para quem lê não é revelado; a API não manda
 * `mesmoCasoQue` nele e manda o aviso genérico, e a tela não marca a linha mascarada nem a outra do par. O detalhe é
 * renderizado no servidor, com a API e a sessão simuladas e a ficha trocada por um marcador.
 */

const simulado = vi.hoisted(() => ({ detalhe: null as unknown }));
vi.mock('@/lib/hooks', () => ({ useApi: () => ({ data: simulado.detalhe, error: null, loading: false, reload: async () => {}, setData: () => {} }) }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ me: { tenant: { timeZone: 'America/Sao_Paulo' } }, can: () => true }) }));
vi.mock('../src/components/consolidacao/surto-ficha', () => ({ SurtoFicha: () => null }));

const { SurtoDetalhe } = await import('../src/components/consolidacao/surto-detalhe');
const planilhaTela = await import('../src/components/consolidacao/surto-planilha');

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
/** Linha mascarada (origem sigilosa que quem lê não abre): só o NU_CASO e os ids, como a API a manda. */
const mascarada = (numero: number, o: Partial<CasoSurto>) => linha(numero, { iniciais: null, sexo: null, idade: null, municipioResidencia: null, inicioSintomas: null, restrito: true, ...o });

const AVISO_PAR = 'Os casos 1 e 2 são o mesmo caso (notificação e registro conciliados): retire uma das linhas.';
const AVISO_OCULTO = 'Há um caso em duas linhas da planilha (notificação e registro conciliados): quem abre as duas origens vê quais. Retire uma delas.';

const detalhe = (planilha: CasoSurto[], casosNaPlanilha: number, avisos: string[]) =>
  ({
    id: 's1',
    numero: '2026/0007',
    status: 'ABERTO',
    categoria: 'DA_LISTA',
    grupo: 'sifilis',
    agravo: 'Sífilis',
    sindrome: null,
    cid: null,
    unidade: { id: 'u1', nome: 'Hospital Municipal São Lucas', cnes: '9000027' },
    notificadoEm: '2026-11-15',
    conhecidoEm: '2026-11-15T12:00:00.000Z',
    primeirosSintomasEm: '2026-11-12',
    casos: 30,
    casosNaPlanilha,
    localInicial: '8',
    localInicialTexto: null,
    esp: false,
    prazos: [],
    numeroOficial: null,
    encerradoEm: null,
    avisos,
    venceEm: '2026-11-16T12:00:00.000Z',
    notificador: 'Vigilância',
    agente: null,
    local: { municipioIbge: null, localidadeId: null, bairroId: null, endereco: null, referencia: null, zona: null, lat: null, lng: null },
    investigacao: { investigadoEm: null, modoTransmissao: null, veiculo: null, veiculoTexto: null, observacoes: null, investigadorNome: null, investigadorFuncao: null },
    dta: null,
    delimitacao: null,
    delimitacaoTexto: null,
    notasEncerramento: null,
    descarte: null,
    sinal: null,
    planilha,
    eventos: [],
    espelho: { campos: [], planilha: [], dta: [], avisos },
    pendencias: [],
    permissoes: { editar: true, encerrar: true, descartar: true, numeroOficial: true },
  }) as unknown as DetalheSurto;

const htmlDetalhe = (d: DetalheSurto) => {
  simulado.detalhe = d;
  return renderToStaticMarkup(createElement(SurtoDetalhe, { id: 's1', opcoes: [], onVoltar: () => {}, onMudou: () => {} }));
};
const cabecalho = (h: string) => /Casos \(informados \/ na planilha\)<\/dt><dd[^>]*>([^<]*)<\/dd>/.exec(h)?.[1]?.replace(/<!-- -->/g, '');
const aba = (h: string) => />(Planilha de casos \(\d+\))</.exec(h)?.[1];
const marcas = (h: string) => [...h.matchAll(/Mesmo caso do caso (\d+)/g)].map((m) => Number(m[1]));

describe('detalhe do surto: casos contados como na lista (R5-9)', () => {
  it('o cabeçalho e a aba contam o caso em duas linhas uma vez', () => {
    // O cenário da verificação (zz-verif-r4vsur-detalhe): 3 linhas, 1 par; a lista diz "2 na planilha".
    const h = htmlDetalhe(
      detalhe([linha(1, { notificationId: 'n1', notificacaoNumero: '2026/000101', mesmoCasoQue: 2 }), linha(2, { officialRecordId: 'r1', mesmoCasoQue: 1 }), linha(3, { iniciais: 'MNL' })], 2, [AVISO_PAR]),
    );
    expect(h).toContain(AVISO_PAR);
    // Antes: '30 / 3' e 'Planilha de casos (3)'.
    expect([cabecalho(h), aba(h)]).toEqual(['30 / 2', 'Planilha de casos (2)']);
  });

  it('sem par, linhas e casos são o mesmo número', () => {
    const h = htmlDetalhe(detalhe([linha(1, { notificationId: 'n1', notificacaoNumero: '2026/000101' }), linha(2, { officialRecordId: 'r1' })], 2, []));
    expect([cabecalho(h), aba(h)]).toEqual(['30 / 2', 'Planilha de casos (2)']);
  });
});

describe('par com uma linha sob sigilo para quem lê (R5-8)', () => {
  it('o detalhe do núcleo: o aviso genérico, nenhuma marca, e o caso contado uma vez', () => {
    // O que a API manda ao núcleo do hospital: a notificação da UBS mascarada, o registro do hospital aberto, sem
    // `mesmoCasoQue` nas duas e com o aviso sem os NU_CASO.
    const h = htmlDetalhe(detalhe([mascarada(1, { notificationId: 'n1' }), linha(2, { officialRecordId: 'r1', iniciais: 'SSQ' })], 1, [AVISO_OCULTO]));
    expect(h).toContain(AVISO_OCULTO);
    expect([h.includes('Os casos 1 e 2'), marcas(h), cabecalho(h), aba(h)]).toEqual([false, [], '30 / 1', 'Planilha de casos (1)']);
  });

  it('a planilha não marca o par em que uma das linhas é sob sigilo, nem se a resposta trouxer a marca', () => {
    // Linhas 1 e 2: a marca como a API mandava antes (decisão 6), com a linha 1 mascarada. Linhas 3 e 4: par aberto.
    const d = detalhe(
      [
        mascarada(1, { notificationId: 'n1', mesmoCasoQue: 2 }),
        linha(2, { officialRecordId: 'r1', iniciais: 'SSQ', mesmoCasoQue: 1 }),
        linha(3, { notificationId: 'n2', notificacaoNumero: '2026/000102', mesmoCasoQue: 4 }),
        linha(4, { officialRecordId: 'r2', mesmoCasoQue: 3 }),
      ],
      2,
      [],
    );
    const h = renderToStaticMarkup(createElement(planilhaTela.SurtoPlanilha, { d, onMudou: () => {} }));
    // Antes: [2, 1, 4, 3] (a linha mascarada e a do registro ligadas pela marca).
    expect(marcas(h)).toEqual([4, 3]);
  });

  it('as marcas do espelho seguem a mesma regra', () => {
    // O espelho (aba "Espelho do Sinan") destaca as linhas pelas mesmas marcas da planilha.
    const marcasMesmoCaso = planilhaTela.marcasMesmoCaso as ((p: CasoSurto[]) => Map<number, number>) | undefined;
    expect(typeof marcasMesmoCaso).toBe('function');
    const m = marcasMesmoCaso!([
      mascarada(1, { notificationId: 'n1', mesmoCasoQue: 2 }),
      linha(2, { officialRecordId: 'r1', mesmoCasoQue: 1 }),
      linha(3, { notificationId: 'n2', mesmoCasoQue: 4 }),
      linha(4, { officialRecordId: 'r2', mesmoCasoQue: 3 }),
    ]);
    expect([...m]).toEqual([
      [3, 4],
      [4, 3],
    ]);
  });
});
