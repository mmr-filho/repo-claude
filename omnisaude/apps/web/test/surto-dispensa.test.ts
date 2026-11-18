import type { RespostaSugestoesSurto, SugestaoSurtoTela } from '@omnisaude/shared';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Diálogo "Dispensar a sugestão" (surtos, quarta rodada da semana 27). Com 409 (chegou caso depois de a lista
 * carregar), o diálogo fechava e o motivo digitado se perdia. Agora ele recarrega a lista e continua aberto (o mesmo
 * componente, com o motivo), apontado para a sugestão nova de mesma assinatura, com o último caso e o número de casos
 * dela e a explicação; se a sugestão saiu da lista (virou surto, por exemplo), o aviso diz isso e o diálogo fecha. O
 * diálogo é renderizado no servidor, com a API, os avisos, a sessão e o Dialog simulados; o clique chama o `onClick`
 * do botão do rodapé.
 */

const simulado = vi.hoisted(() => ({
  rodape: null as ReactElement<{ onClick: () => Promise<void> }> | null,
  post: vi.fn(),
  get: vi.fn(),
  avisos: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// O Dialog do Radix só monta no navegador (portal): aqui ele mostra o conteúdo direto e guarda o rodapé (o botão).
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactElement<{ onClick: () => Promise<void> }> }) => {
    simulado.rodape = footer ?? null;
    return createElement('section', { 'aria-label': title }, children, footer);
  },
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => simulado.avisos }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ me: { tenant: { timeZone: 'America/Sao_Paulo' } }, can: () => true }) }));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { post: simulado.post, get: simulado.get } }));

const { ApiError } = await import('../src/lib/api');
const { fmtDateTimeTz } = await import('../src/lib/format');
const { DispensarSugestao } = await import('../src/components/consolidacao/surto-sugestoes');
const { corpoDispensa, sugestaoAtualizada, TEXTO_SUGESTAO_MUDOU, TEXTO_SUGESTAO_SAIU } = await import('../src/components/consolidacao/surto-regras');

const ASSINATURA = 'quarteirao-7d|QUARTEIRAO:0190a000-0000-7000-8000-0000000000q1|hantavirose';
const caso = (id: string, conhecidoEm: string) => ({ id, numero: `2026/000${id}`, agravo: 'Hantavirose', unidade: 'UBS Centro', bairro: 'Centro', inicioSintomas: '2026-11-08', conhecidoEm });
const mostrada: SugestaoSurtoTela = {
  assinatura: ASSINATURA,
  regra: 'quarteirao-7d',
  descricao: 'Dois ou mais casos do mesmo agravo no mesmo quarteirão em 7 dias',
  grupo: 'hantavirose',
  vinculo: { tipo: 'QUARTEIRAO', id: '0190a000-0000-7000-8000-0000000000q1' },
  casos: ['101', '102'],
  primeiroSintoma: '2026-11-08',
  ultimoConhecimento: '2026-11-10T13:00:00.000Z',
  fonte: 'GVS',
  vinculoNome: 'Quarteirão 12 (Centro)',
  casosDetalhe: [caso('101', '2026-11-09T13:00:00.000Z'), caso('102', '2026-11-10T13:00:00.000Z')],
};
// A mesma sugestão (mesma assinatura) depois de chegar o terceiro caso, conhecido às 17:30 de Brasília.
const nova: SugestaoSurtoTela = { ...mostrada, casos: ['101', '102', '103'], ultimoConhecimento: '2026-11-10T20:30:00.000Z', casosDetalhe: [...mostrada.casosDetalhe, caso('103', '2026-11-10T20:30:00.000Z')] };
const outra: SugestaoSurtoTela = { ...mostrada, assinatura: 'bairro-7d|BAIRRO:b1|hantavirose', regra: 'bairro-7d' };
const lista = (...sugestoes: SugestaoSurtoTela[]): RespostaSugestoesSurto => ({ sugestoes, excessos: [], avisos: [] });

type Props = Parameters<typeof DispensarSugestao>[0];
const html = (props: Props) => renderToStaticMarkup(createElement(DispensarSugestao, props));
const props = (o: Partial<Props> = {}): Props => ({ s: mostrada, mudou: false, onFechar: vi.fn(), onFeito: vi.fn(), onLista: vi.fn(), ...o });
/** Clica em "Dispensar" (o onClick do botão do rodapé do último diálogo renderizado). */
const dispensar = async () => simulado.rodape!.props.onClick();

beforeEach(() => {
  simulado.rodape = null;
  simulado.post.mockReset();
  simulado.get.mockReset();
  for (const f of Object.values(simulado.avisos)) f.mockReset();
});

describe('dispensa da sugestão de surto', () => {
  it('mostra o número de casos e o último caso conhecido da sugestão (no fuso da instituição)', () => {
    const h = html(props());
    expect(h).toContain(`2 caso(s) · último caso conhecido em ${fmtDateTimeTz('2026-11-10T13:00:00.000Z', 'America/Sao_Paulo')}`);
    expect(fmtDateTimeTz('2026-11-10T13:00:00.000Z', 'America/Sao_Paulo')).toContain('10:00');
    expect(h).not.toContain(TEXTO_SUGESTAO_MUDOU);
  });

  it('409: a lista é recarregada e o diálogo continua aberto, apontado para a sugestão nova de mesma assinatura', async () => {
    const p = props();
    html(p);
    simulado.post.mockRejectedValueOnce(new ApiError(409, 'A sugestão mudou desde que a tela foi aberta: abra de novo.', 'CONFLITO'));
    simulado.get.mockResolvedValueOnce(lista(outra, nova));
    await dispensar();
    expect(simulado.post).toHaveBeenCalledWith('/vigilancia/surtos/sugestoes/dispensar', corpoDispensa(mostrada, ''));
    expect(simulado.get).toHaveBeenCalledWith('/vigilancia/surtos/sugestoes');
    // Antes: o 409 virava aviso de erro e o diálogo fechava (onFeito), perdendo o motivo digitado.
    expect(p.onLista).toHaveBeenCalledWith(lista(outra, nova), nova);
    expect(p.onFeito).not.toHaveBeenCalled();
    expect(p.onFechar).not.toHaveBeenCalled();
    expect(simulado.avisos.error).not.toHaveBeenCalled();
    expect(simulado.avisos.info).not.toHaveBeenCalled();
  });

  it('o diálogo apontado para a sugestão nova explica a mudança, mostra o novo último caso e o número de casos e dispensa até ele', async () => {
    const p = props({ s: nova, mudou: true });
    const h = html(p);
    expect(h).toContain(TEXTO_SUGESTAO_MUDOU);
    expect(TEXTO_SUGESTAO_MUDOU).toBe('Chegou caso novo depois de a lista carregar: confira antes de dispensar.');
    expect(h).toContain(`3 caso(s) · último caso conhecido em ${fmtDateTimeTz('2026-11-10T20:30:00.000Z', 'America/Sao_Paulo')}`);
    expect(fmtDateTimeTz('2026-11-10T20:30:00.000Z', 'America/Sao_Paulo')).toContain('17:30');
    // A nova tentativa vale até o último caso que o diálogo mostra agora.
    simulado.post.mockResolvedValueOnce({ ok: true });
    await dispensar();
    expect(simulado.post).toHaveBeenCalledWith('/vigilancia/surtos/sugestoes/dispensar', { assinatura: ASSINATURA, motivo: '', ultimoConhecimento: '2026-11-10T20:30:00.000Z' });
    expect(simulado.avisos.success).toHaveBeenCalledWith('Sugestão dispensada.');
    expect(p.onFeito).toHaveBeenCalledTimes(1);
  });

  it('409 e a sugestão saiu da lista (virou surto, por exemplo): o aviso diz isso e o diálogo fecha', async () => {
    const p = props();
    html(p);
    simulado.post.mockRejectedValueOnce(new ApiError(409, 'A sugestão mudou desde que a tela foi aberta: abra de novo.', 'CONFLITO'));
    simulado.get.mockResolvedValueOnce(lista(outra));
    await dispensar();
    expect(p.onLista).toHaveBeenCalledWith(lista(outra), null);
    expect(simulado.avisos.info).toHaveBeenCalledWith(TEXTO_SUGESTAO_SAIU);
    expect(p.onFechar).toHaveBeenCalledTimes(1);
    expect(p.onFeito).not.toHaveBeenCalled();
  });

  it('404 (a sugestão já não existe na API): a lista é recarregada, o aviso diz isso e o diálogo fecha', async () => {
    const p = props();
    html(p);
    simulado.post.mockRejectedValueOnce(new ApiError(404, 'Sugestão não encontrada: já dispensada, já virou surto ou ficou sem casos', 'NAO_ENCONTRADO'));
    simulado.get.mockResolvedValueOnce(lista(outra));
    await dispensar();
    expect(p.onLista).toHaveBeenCalledWith(lista(outra), null);
    expect(simulado.avisos.info).toHaveBeenCalledWith(TEXTO_SUGESTAO_SAIU);
    expect(p.onFechar).toHaveBeenCalledTimes(1);
  });

  it('outro erro fica no diálogo, sem recarregar a lista nem fechar', async () => {
    const p = props();
    html(p);
    simulado.post.mockRejectedValueOnce(new ApiError(400, 'Motivo curto demais', 'VALIDACAO'));
    await dispensar();
    expect(simulado.get).not.toHaveBeenCalled();
    expect(p.onLista).not.toHaveBeenCalled();
    expect(p.onFechar).not.toHaveBeenCalled();
    expect(p.onFeito).not.toHaveBeenCalled();
  });

  it('a sugestão atualizada é a de mesma assinatura (a mesma chave) na lista nova', () => {
    expect(sugestaoAtualizada([outra, nova], ASSINATURA)).toBe(nova);
    expect(sugestaoAtualizada([outra], ASSINATURA)).toBeNull();
  });
});
