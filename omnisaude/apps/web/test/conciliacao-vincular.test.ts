import type { ListaCandidatasVinculo, ListaSoOficial } from '@omnisaude/shared';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Diálogo "Vincular…" da conciliação, quarta rodada da semana 27 (N5): para um registro oficial, as notificações vêm
 * das candidatas ao vínculo (GET /vigilancia/conciliacao/candidatas), que não dependem da cobertura das importações. A
 * lista "só no OmniSaúde" deixou de ter a notificação do mesmo caso feita em outra unidade (arquivo de um CNES só) ou
 * depois do envio, e o diálogo mostrava "Nada encontrado". Para uma notificação, o registro continua vindo do "só no
 * oficial". O diálogo é renderizado no servidor, com as respostas da API, a sessão e o Dialog simulados.
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

// O Dialog do Radix só monta no navegador (portal): aqui ele mostra o conteúdo direto.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => createElement('section', { 'aria-label': title }, children, footer),
}));

const { DialogoVincular } = await import('../src/components/consolidacao/conciliacao-listas');

const registro = {
  id: 'r1',
  sistema: 'ESUS_NOTIFICA',
  tipo: 'INDIVIDUAL',
  numero: '352611110001',
  notificadoEm: '2026-11-15',
  semanaNotificacao: '202646',
  agravo: null,
  grupo: 'covid',
  agravoNome: 'Covid-19',
  unidade: { id: 'u2', cnes: '9000036', nome: 'UPA Norte' },
  situacao: 'CONFIRMADO',
  gravidade: null,
  evolucao: null,
  encerradoEm: null,
  paciente: { nome: 'Fulana Cnes Souza', nascimento: '1975-05-05', sexo: 'F' },
  sigiloso: false,
  excluido: false,
  ausenteDesde: null,
  vinculo: null,
};
const notificacao = {
  id: 'n1',
  numero: '2026/000777',
  status: 'NOTIFICADA',
  grupo: 'covid',
  agravo: 'Covid-19',
  notificadaEm: '2026-11-15T13:00:00.000Z',
  inicioSintomas: '2026-11-12',
  unidade: { id: 'u1', nome: 'UBS Centro' },
  paciente: { nome: 'Fulana Verificacao Cnes Souza', nascimento: '1975-05-05', sexo: 'F' },
  sigilosa: false,
  sistemaOficial: 'ESUS_NOTIFICA',
  numeroOficial: null,
  situacao: 'EM_INVESTIGACAO',
};
const pagina = <T>(itens: T[]) => ({ total: itens.length, pagina: 1, porPagina: 50, itens });
const html = (props: Parameters<typeof DialogoVincular>[0]) => renderToStaticMarkup(createElement(DialogoVincular, props));

beforeEach(() => {
  simulado.respostas.clear();
  simulado.pedidos = [];
});

describe('"Vincular…" do registro oficial busca nas candidatas ao vínculo (N5)', () => {
  it('o registro pede as candidatas no agravo dele (não o "só no OmniSaúde") e mostra a notificação feita em outra unidade', () => {
    simulado.respostas.set('/vigilancia/conciliacao/candidatas', pagina([notificacao]) as unknown as ListaCandidatasVinculo);
    const h = html({ registro: registro as never, notificacao: null, onFechar: () => {}, onFeito: () => {} });
    expect(simulado.pedidos).toEqual(['/vigilancia/conciliacao/candidatas?grupo=covid']);
    expect(h).toContain('2026/000777');
    expect(h).toContain('UBS Centro');
    expect(h).not.toContain('Nada encontrado');
  });

  it('a notificação continua buscando o registro no "só no oficial"', () => {
    simulado.respostas.set('/vigilancia/conciliacao/so-oficial', pagina([registro]) as unknown as ListaSoOficial);
    const h = html({ registro: null, notificacao: notificacao as never, onFechar: () => {}, onFeito: () => {} });
    expect(simulado.pedidos).toEqual(['/vigilancia/conciliacao/so-oficial?grupo=covid']);
    expect(h).toContain('352611110001');
  });

  it('com o par já escolhido (sugestão), não busca nada', () => {
    html({ registro: registro as never, notificacao: notificacao as never, onFechar: () => {}, onFeito: () => {} });
    expect(simulado.pedidos).toEqual([]);
  });
});
