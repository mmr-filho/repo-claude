import type { ListaUnidadesNotificantes } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Telas da notificação negativa e do cadastro (terceira rodada da semana 27), renderizadas no servidor com a API e a
 * sessão simuladas. "Desativar" a unidade pede confirmação com o efeito na negativa (TELAS-2); o "Revogar" de cada
 * responsável diz de quem é a designação (TELAS-7); a designação que não vale aparece marcada e não conta como titular
 * (NEGATIVA-4); a unidade reativada sem período conta em "sem configuração" (sur-7); e a gestão da vigilância tem o
 * atalho para os prazos e parâmetros, que a aba da negativa abre pela URL (K3). Os botões guardam o que fariam ao
 * clicar: o teste chama o clique e confere o pedido à API.
 */

const simulado = vi.hoisted(() => ({
  respostas: new Map<string, unknown>(),
  busca: new URLSearchParams(),
  botoes: [] as { texto: string; rotulo?: string; onClick?: () => unknown }[],
}));

vi.mock('@/lib/hooks', () => ({
  useApi: (path: string | null) => {
    const chave = path ? [...simulado.respostas.keys()].find((k) => path.startsWith(k)) : undefined;
    return { data: chave ? simulado.respostas.get(chave) : null, error: null, loading: false, reload: async () => {}, setData: () => {} };
  },
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({ me: { tenant: { timeZone: 'America/Sao_Paulo' }, context: { role: 'VIGILANCIA_EPIDEMIOLOGICA', unitId: 'u1' }, permissions: [] }, can: () => true }),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => simulado.busca }));

// O diálogo aparece inline (o Radix usa portal, que não sai na renderização no servidor).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  return {
    Dialog: (p: { open: boolean; title: string; description?: string; children: unknown; footer?: unknown }) =>
      p.open ? h('section', { 'data-dialogo': p.title }, h('h2', null, p.title), p.description ? h('p', null, p.description) : null, p.children as never, p.footer as never) : null,
  };
});

// O botão de verdade, que também guarda o clique (texto e nome acessível) para o teste chamar.
vi.mock('@/components/ui/button', async () => {
  const { createElement: h, isValidElement } = await import('react');
  const texto = (n: unknown): string =>
    typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(texto).join('') : isValidElement(n) ? texto((n.props as { children?: unknown }).children) : '';
  return {
    Button: ({ loading, variant: _v, size: _s, children, ...p }: { loading?: boolean; variant?: string; size?: string; children?: unknown; onClick?: () => unknown; 'aria-label'?: string; disabled?: boolean }) => {
      simulado.botoes.push({ texto: texto(children).replace(/\s+/g, ' ').trim(), rotulo: p['aria-label'], onClick: p.onClick });
      return h('button', { type: 'button', ...p, onClick: undefined, disabled: p.disabled || loading }, children as never);
    },
  };
});

const { api } = await import('../src/lib/api');
const { UnitsAdmin, ConfirmarDesativacao } = await import('../src/components/admin/units-admin');
const { NegativaUnidades } = await import('../src/components/consolidacao/negativa-unidades');
const { AbaNegativa } = await import('../src/components/consolidacao/negativa');
const { PlantaoTab } = await import('../src/components/vigilancia/gestao');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));
const botao = (texto: string) => simulado.botoes.filter((b) => b.texto === texto);
const estatistica = (h: string, rotulo: string) => /(\d+)/.exec(h.slice(h.indexOf(rotulo) + rotulo.length).replace(/<[^>]+>/g, ' '))?.[1] ?? null;

beforeEach(() => {
  simulado.respostas.clear();
  simulado.botoes = [];
  simulado.busca = new URLSearchParams();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cadastro de unidades: desativar pede confirmação (TELAS-2)', () => {
  const unidade = { id: 'u1', name: 'UBS Centro', type: 'UBS', cnes: '9000011', ibgeCode: '3550308', address: null, phone: null, email: null, openingHours: null, active: true, _count: { assignments: 7 } };

  it('o clique em "Desativar" não desativa: abre a confirmação; "Reativar" é direto', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    simulado.respostas.set('/admin/units', [unidade, { ...unidade, id: 'u2', name: 'UBS Jardim', cnes: '9000028', active: false }]);
    html(UnitsAdmin, {});
    const [desativar] = botao('Desativar');
    expect(desativar?.onClick).toBeTypeOf('function');
    await desativar!.onClick!();
    expect(patch).not.toHaveBeenCalled();
    await botao('Reativar')[0]!.onClick!();
    expect(patch).toHaveBeenCalledExactlyOnceWith('/admin/units/u2', { active: true });
  });

  it('a confirmação diz o que acontece na notificação negativa e só então desativa', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
    const feito = vi.fn();
    const h = html(ConfirmarDesativacao, { unit: unidade, onFechar: () => {}, onFeito: feito });
    expect(h).toContain('data-dialogo="Desativar UBS Centro?"');
    expect(h).toContain('A unidade deixa de aparecer nas lotações e nas agendas.');
    expect(h).toContain('Encerra hoje o período de unidade notificante e as designações de responsável pela notificação negativa (o que só começaria depois de hoje é apagado); reativar não os reabre.');
    expect(botao('Cancelar')).toHaveLength(1);
    await botao('Desativar')[0]!.onClick!();
    expect(patch).toHaveBeenCalledExactlyOnceWith('/admin/units/u1', { active: false });
    expect(feito).toHaveBeenCalledOnce();
  });
});

describe('unidades notificantes e responsáveis', () => {
  const aberto = { id: 'p1', desde: '2026-01-01', ate: null, motivoFim: null };
  const lista: ListaUnidadesNotificantes = [
    {
      unidade: { id: 'u1', nome: 'UPA 24h Norte', cnes: '9000036' },
      tipoUnidade: 'UPA',
      ativa: true,
      periodoAtual: aberto,
      periodos: [aberto],
      responsaveis: [
        {
          id: 'r1',
          userId: 'x1',
          nome: 'Íris Campos Gestora',
          tipo: 'TITULAR',
          desde: '2026-01-01',
          ate: null,
          designadoEm: '2026-06-17T15:00:00.000Z',
          designadoPor: 'Vera',
          valido: false,
          motivoInvalido: 'Sem lotação ativa na unidade',
        },
        { id: 'r2', userId: 'x2', nome: 'Bruno Almeida Enfermeiro', tipo: 'SUBSTITUTO', desde: '2026-01-01', ate: null, designadoEm: '2026-06-17T15:00:00.000Z', designadoPor: 'Vera', valido: true, motivoInvalido: null },
      ],
      semConfiguracao: false,
      avisos: ['Titular sem lotação ativa na unidade em papel que atesta: a designação não vale.'],
    },
    {
      unidade: { id: 'u2', nome: 'UBS Reativada', cnes: '9002731' },
      tipoUnidade: 'UBS',
      ativa: true,
      periodoAtual: null,
      periodos: [{ id: 'p2', desde: '2026-01-01', ate: '2026-06-17', motivoFim: 'Unidade desativada no cadastro' }],
      responsaveis: [],
      semConfiguracao: true,
      avisos: ['Unidade reativada: o período de notificante terminou na desativação. Abra um período novo se ela voltou a notificar.'],
    },
  ];

  it('cada "Revogar" diz de quem é a designação, o tipo e de qual unidade (TELAS-7, R5-10; "da unidade <nome>", R6-6; o tipo, r6vout-1)', () => {
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    const h = html(NegativaUnidades, {});
    expect(botao('Revogar').map((b) => b.rotulo)).toEqual([
      'Revogar a designação de Íris Campos Gestora (titular) como responsável da unidade UPA 24h Norte',
      'Revogar a designação de Bruno Almeida Enfermeiro (substituto) como responsável da unidade UPA 24h Norte',
    ]);
    expect(h).toContain('aria-label="Revogar a designação de Íris Campos Gestora (titular) como responsável da unidade UPA 24h Norte"');
  });

  it('a designação que não vale aparece marcada e a unidade conta como sem titular (NEGATIVA-4); a reativada conta como sem configuração (sur-7)', () => {
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    const h = html(NegativaUnidades, {});
    expect(h).toContain('Não vale');
    expect(h).toContain('Sem lotação ativa na unidade');
    expect(h).toContain('Titular sem lotação ativa na unidade em papel que atesta: a designação não vale.');
    expect(estatistica(h, 'Notificantes sem titular')).toBe('1');
    // O substituto que vale ainda atesta.
    expect(estatistica(h, 'Sem nenhum responsável')).toBe('0');
    expect(estatistica(h, 'Sem configuração')).toBe('1');
    expect(h).toContain('Unidade reativada: o período de notificante terminou na desativação. Abra um período novo se ela voltou a notificar.');
    // A reativada pode voltar a ser notificante pela própria linha.
    expect(botao('Tornar notificante')).toHaveLength(1);
  });
});

describe('atalho para os prazos e parâmetros (K3)', () => {
  it('a aba Plantão da gestão da vigilância leva a Consolidação e surtos > Notificação negativa > Prazos e parâmetros', () => {
    const h = html(PlantaoTab, {});
    expect(h).toContain('href="/vigilancia/consolidacao?aba=negativa&amp;secao=parametros"');
    expect(h).toContain('Consolidação e surtos › Notificação negativa › Prazos e parâmetros');
    expect(h).toContain('Lá se ajustam o prazo do atesto e a meta da notificação negativa');
  });

  it('a aba Notificação negativa abre a seção pedida na URL, se a pessoa pode vê-la', () => {
    const selecionada = (h: string) => /<button[^>]*aria-selected="true"[^>]*>([^<]+)<\/button>/.exec(h)?.[1];
    simulado.busca = new URLSearchParams('aba=negativa&secao=parametros');
    expect(selecionada(html(AbaNegativa, { podeConfigurar: true, podeParametros: true }))).toBe('Prazos e parâmetros');
    // Sem a permissão dos parâmetros, a grade.
    expect(selecionada(html(AbaNegativa, { podeConfigurar: true, podeParametros: false }))).toBe('Grade das unidades');
    simulado.busca = new URLSearchParams('aba=negativa');
    expect(selecionada(html(AbaNegativa, { podeConfigurar: true, podeParametros: true }))).toBe('Grade das unidades');
  });
});
