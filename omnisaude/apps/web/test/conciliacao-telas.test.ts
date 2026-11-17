import type { ListaBairrosSemCorrespondencia, ListaSoOficial, ListaSoOmnisaude, ListaSugestoesVinculo, ListaVinculados } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Aba Conciliação, terceira rodada da semana 27: os botões que se repetem em cada linha dizem de qual registro ou
 * notificação são (TELAS-7), a lista de bairros sem correspondência vem em páginas de 50, como as outras
 * (conciliacao-1), e a cobertura da importação de um CNES só mostra o CNES (imp-cobertura-so-omni). As telas são
 * renderizadas no servidor, com as respostas da API e a sessão simuladas.
 */

const simulado = vi.hoisted(() => ({ respostas: new Map<string, unknown>(), pedidos: [] as string[] }));

vi.mock('@/lib/hooks', () => ({
  useApi: (path: string | null) => {
    if (path) simulado.pedidos.push(path);
    const chave = path ? [...simulado.respostas.keys()].find((k) => path.startsWith(k)) : undefined;
    return { data: chave ? simulado.respostas.get(chave) : null, error: null, loading: false, reload: async () => {}, setData: () => {} };
  },
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({
    me: { tenant: { timeZone: 'America/Sao_Paulo' }, context: { role: 'VIGILANCIA_EPIDEMIOLOGICA', unitId: 'u1' }, permissions: ['vigilancia.importar', 'notificacao.sensivel'] },
    can: () => true,
  }),
}));

const { ListaDivergentesConciliacao, ListaSoNoOficial, ListaSoNoOmnisaude, ListaSugestoesConciliacao, ListaVinculadosConciliacao } = await import('../src/components/consolidacao/conciliacao-listas');
const { ListaBairrosConciliacao } = await import('../src/components/consolidacao/conciliacao-bairros');
const { textoCobertura } = await import('../src/components/consolidacao/conciliacao-regras');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));
/** Os botões do HTML com o nome acessível (aria-label) e o texto. */
const botoes = (h: string) => [...h.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ rotulo: /aria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? null, texto: m[2]!.replace(/<[^>]+>/g, '').trim() }));
const rotulos = (h: string, texto: string) =>
  botoes(h)
    .filter((b) => b.texto === texto)
    .map((b) => b.rotulo);

const registro = (id: string, numero: string) => ({
  id,
  sistema: 'SINAN_NET',
  tipo: 'INDIVIDUAL',
  numero,
  notificadoEm: '2026-11-02',
  semanaNotificacao: '202645',
  agravo: 'A379',
  grupo: 'coqueluche',
  agravoNome: 'Coqueluche',
  unidade: { id: 'u1', cnes: '9000011', nome: 'UBS Centro' },
  situacao: 'CONFIRMADO',
  gravidade: null,
  evolucao: null,
  encerradoEm: null,
  paciente: { nome: 'Ana Souza', nascimento: '1990-02-01', sexo: 'F' },
  sigiloso: false,
  excluido: false,
  ausenteDesde: null,
  vinculo: null,
});
const notificacao = (id: string, numero: string) => ({
  id,
  numero,
  status: 'NOTIFICADA',
  grupo: 'coqueluche',
  agravo: 'Coqueluche',
  notificadaEm: '2026-11-02T13:00:00.000Z',
  inicioSintomas: '2026-10-30',
  unidade: { id: 'u1', nome: 'UBS Centro' },
  paciente: { nome: 'Ana Souza', nascimento: '1990-02-01', sexo: 'F' },
  sigilosa: false,
  sistemaOficial: 'SINAN_NET',
  numeroOficial: null,
  situacao: 'EM_INVESTIGACAO',
});
const pagina = <T>(itens: T[], total = itens.length) => ({ total, pagina: 1, porPagina: 50, itens });

beforeEach(() => {
  simulado.respostas.clear();
  simulado.pedidos = [];
});

describe('botões repetidos em cada linha com o objeto no nome acessível (TELAS-7)', () => {
  it('"Vincular…" do só no oficial e do só no OmniSaúde dizem qual registro e qual notificação', () => {
    simulado.respostas.set('/vigilancia/conciliacao/so-oficial', pagina([registro('r1', '7700001'), registro('r2', '7700002')]) as unknown as ListaSoOficial);
    expect(rotulos(html(ListaSoNoOficial, { filtro: {}, onMudou: () => {} }), 'Vincular…')).toEqual(['Vincular o registro 7700001', 'Vincular o registro 7700002']);
    simulado.respostas.set('/vigilancia/conciliacao/so-omnisaude', pagina([notificacao('n1', '2026/000101'), notificacao('n2', '2026/000102')]) as unknown as ListaSoOmnisaude);
    expect(rotulos(html(ListaSoNoOmnisaude, { filtro: {}, onMudou: () => {} }), 'Vincular…')).toEqual(['Vincular a notificação 2026/000101', 'Vincular a notificação 2026/000102']);
  });

  it('"Desvincular…" dos vinculados e dos divergentes, e "Vincular" e "Não é o mesmo caso" das sugestões', () => {
    const pares = pagina([
      { registro: registro('r1', '7700001'), notificacao: notificacao('n1', '2026/000101'), divergencias: [] },
      { registro: registro('r2', '7700002'), notificacao: notificacao('n2', '2026/000102'), divergencias: [{ campo: 'situacao', oficial: 'CONFIRMADO', omnisaude: 'EM_INVESTIGACAO' }] },
    ]) as unknown as ListaVinculados;
    simulado.respostas.set('/vigilancia/conciliacao/vinculados', pares);
    simulado.respostas.set('/vigilancia/conciliacao/divergentes', pares);
    for (const lista of [ListaVinculadosConciliacao, ListaDivergentesConciliacao])
      expect(rotulos(html(lista, { filtro: {}, onMudou: () => {} }), 'Desvincular…')).toEqual(['Desvincular o registro 7700001', 'Desvincular o registro 7700002']);
    simulado.respostas.set(
      '/vigilancia/conciliacao/sugestoes',
      pagina([{ registro: registro('r3', '7700003'), notificacao: notificacao('n3', '2026/000103'), degrau: 3, motivo: 'mesmo nome, nascimento e sexo' }]) as unknown as ListaSugestoesVinculo,
    );
    const h = html(ListaSugestoesConciliacao, { filtro: {}, onMudou: () => {} });
    expect(rotulos(h, 'Vincular')).toEqual(['Vincular o registro 7700003 à notificação 2026/000103']);
    expect(rotulos(h, 'Não é o mesmo caso')).toEqual(['Não é o mesmo caso: registro 7700003 e notificação 2026/000103']);
    // O nome acessível começa pelo texto do botão (WCAG 2.5.3).
    for (const b of botoes(h).filter((x) => x.rotulo)) expect(b.rotulo!.startsWith(b.texto.replace(/…$/, ''))).toBe(true);
  });
});

describe('bairros sem correspondência em páginas de 50 (conciliacao-1)', () => {
  const bairro = (nome: string, registros: number) => ({ nome, nomeNormalizado: nome, codigo: null, registros, candidatos: [{ neighborhoodId: 'b1', nome: 'Jardim Oficial 7', localidade: null }] });

  it('pede a página à API e mostra a navegação como nas outras listas; o botão de apelido diz qual nome', () => {
    simulado.respostas.set('/vigilancia/conciliacao/bairros', pagina([bairro('JARDIM OFICIAL 7A', 5), bairro('VL NOVA', 3)], 120) as ListaBairrosSemCorrespondencia);
    const h = html(ListaBairrosConciliacao, { podeEditarTerritorio: true, onMudou: () => {} });
    expect(simulado.pedidos).toEqual(['/vigilancia/conciliacao/bairros']);
    expect(h).toContain('JARDIM OFICIAL 7A');
    expect(h).toContain('Jardim Oficial 7');
    expect(h).toContain('1 a 2 de 120');
    expect(rotulos(h, 'Adicionar apelido…')).toEqual(['Adicionar apelido: JARDIM OFICIAL 7A', 'Adicionar apelido: VL NOVA']);
    expect(botoes(h).filter((b) => b.rotulo === 'Próxima página')).toHaveLength(1);
  });

  it('sem nenhum nome, a mensagem de tudo com correspondência', () => {
    simulado.respostas.set('/vigilancia/conciliacao/bairros', pagina([]) as ListaBairrosSemCorrespondencia);
    expect(html(ListaBairrosConciliacao, { podeEditarTerritorio: false, onMudou: () => {} })).toContain('Todos os nomes de bairro têm correspondência no território');
  });
});

describe('cobertura da importação de um CNES só (imp-cobertura-so-omni)', () => {
  it('o texto da cobertura leva o CNES; sem ele, fica como antes', () => {
    expect(textoCobertura({ sistema: 'ESUS_NOTIFICA', grupos: ['covid'], cnes: '9000036', de: '2026-11-01', ate: '2026-11-16' })).toBe('e-SUS Notifica · covid · só o CNES 9000036 · 01/11/2026 a 16/11/2026');
    expect(textoCobertura({ sistema: 'SINAN_NET', grupos: null, cnes: null, de: '2026-01-01', ate: '2026-11-16' })).toBe('Sinan Net · 01/01/2026 a 16/11/2026');
  });
});
