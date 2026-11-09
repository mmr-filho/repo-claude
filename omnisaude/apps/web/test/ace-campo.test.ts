import { describe, expect, it } from 'vitest';
import type { LoteCampo, PacoteCampo, ProdutoCampo } from '@/components/endemias/types';
import {
  ajustarLinhaAutomatica,
  aplicarAceitosNoPacote,
  classificarFalha,
  errosPorOperacao,
  loteSugerido,
  numeroDoBotao,
  ordemDoFormulario,
  produtoSugerido,
  produtosDoFormulario,
  quantidadeParaTexto,
  seguinteTubito,
  type ImovelOp,
  type LinhaTratamento,
  type VisitaOp,
} from '@/lib/ace-campo';
import { ApiError } from '@/lib/api';

const lote = (loteId: string, vencido: boolean, produtoId = 'bti', saldo = 100): LoteCampo => ({
  produtoId,
  produto: produtoId.toUpperCase(),
  unidade: 'g',
  tipo: 'LARVICIDA',
  loteId,
  lote: loteId.toUpperCase(),
  validade: vencido ? '2026-01-31' : '2027-06-30',
  vencido,
  saldo,
  deposito: 'Depósito de endemias',
});
const CATALOGO: ProdutoCampo[] = [
  { id: 'bti', codigo: 'BTI', descricao: 'Bacillus thuringiensis israelensis (Bti) WG', unidade: 'g', tipo: 'LARVICIDA' },
  { id: 'ppf', codigo: 'PPF', descricao: 'Piriproxifeno 0,5% GR', unidade: 'g', tipo: 'LARVICIDA' },
];

const pacoteBase = (): PacoteCampo => ({
  ciclo: { ano: 2026, ciclo: 6, chave: '2026-6', inicio: '2026-11-01', fim: '2026-12-31' },
  zonas: [{ id: 'z1', nome: 'Zona 1', quarteiroes: ['q1'] }],
  ordens: [
    { id: 'o-antiga', numero: '1/2026', status: 'EM_CAMPO', abertaEm: '2026-11-01T10:00:00Z', raioM: 300, conferirImovel: false, quarteiroes: [{ id: 'q1', ocorrencia: true }], visitados: {} },
    { id: 'o-nova', numero: '2/2026', status: 'ABERTA', abertaEm: '2026-11-05T10:00:00Z', raioM: 300, conferirImovel: false, quarteiroes: [{ id: 'q1', ocorrencia: false }], visitados: {} },
  ],
  quarteiroes: [{ id: 'q1', numero: '1', localidade: null, bairro: null, centro: { lat: -10.18, lng: -48.33 }, geometria: null, ativo: true }],
  imoveis: [
    {
      id: 'h1',
      quarteiraoId: 'q1',
      sequencia: '1',
      endereco: 'Rua Exemplo, 100',
      tipo: '01',
      tipoLabel: 'Residência',
      lat: null,
      lng: null,
      posicaoAproximada: true,
      precisaoLabel: 'Sem posição',
      observacao: null,
      noCiclo: null,
    },
  ],
  produtos: CATALOGO,
  estoque: [lote('l-bti', false, 'bti', 100)],
  servidorEm: '2026-11-07T08:00:00Z',
});

const visita = (clientId: string, extra: Omit<Partial<VisitaOp>, 'visita'> & { visita?: Partial<VisitaOp['visita']> } = {}): VisitaOp => {
  const { visita: v, ...resto } = extra;
  return {
    tipo: 'VISITA_VETORIAL',
    clientId,
    registradoEm: '2026-11-07T12:00:00Z',
    householdId: 'h1',
    ...resto,
    visita: { atividade: 'LI_T', situacao: 'TRABALHADO', ...v },
  };
};
const imovelNovo = (clientId: string): ImovelOp => ({
  tipo: 'IMOVEL',
  clientId,
  registradoEm: '2026-11-07T11:00:00Z',
  dados: { blockId: 'q1', sequencia: '7a', propertyType: '01', street: 'Travessa Nova', number: '7', observacoes: 'Casa de fundos' },
});

describe('larvicida no formulário de visita', () => {
  it('lote sugerido pula o vencido nos três lugares (linha automática, + Produto e troca de produto)', () => {
    // O pacote vem do mais perto de vencer: o primeiro pode estar vencido.
    expect(loteSugerido([lote('bti2501', true), lote('bti2601', false)])).toBe('bti2601');
    expect(loteSugerido([lote('bti2501', true)])).toBe('bti2501');
    expect(loteSugerido([])).toBeNull();
  });

  it('produto sem saldo no pacote continua no formulário (catálogo), com os lotes com saldo como sugestão', () => {
    const lista = produtosDoFormulario(CATALOGO, [lote('ppf2502', false, 'ppf')]);
    expect(lista.map((p) => [p.id, p.lotes.length])).toEqual([
      ['bti', 0],
      ['ppf', 1],
    ]);
    // Sem nenhum lote com saldo (remessa ainda não lançada): os produtos aparecem do mesmo jeito.
    expect(produtosDoFormulario(CATALOGO, []).map((p) => p.id)).toEqual(['bti', 'ppf']);
    // Pacote guardado por versão anterior, sem catálogo: só os produtos com lote.
    expect(produtosDoFormulario(undefined, [lote('ppf2502', false, 'ppf')]).map((p) => p.id)).toEqual(['ppf']);
  });

  it('linha nova sugere o produto com lote válido e deixa o já usado em outra linha para o fim', () => {
    const lista = produtosDoFormulario(CATALOGO, [lote('ppf2502', false, 'ppf')]);
    expect(produtoSugerido(lista)?.id).toBe('ppf');
    expect(produtoSugerido(lista, new Set(['ppf']))?.id).toBe('bti');
    expect(produtoSugerido(produtosDoFormulario(CATALOGO, []))?.id).toBe('bti');
    expect(produtoSugerido([])).toBeNull();
  });

  it('a linha criada pela tabela acompanha o total de tratados digitado ("12" passa por "1")', () => {
    const criar = (n: number): LinhaTratamento => ({ chave: 'x', produtoId: 'bti', loteId: 'l-bti', loteNumero: null, quantidade: 0, qtdTexto: '', depositos: n, automatica: true });
    let linhas = ajustarLinhaAutomatica([], 1, criar);
    expect(linhas.map((l) => l.depositos)).toEqual([1]);
    linhas = ajustarLinhaAutomatica(linhas, 12, criar);
    expect(linhas.map((l) => l.depositos)).toEqual([12]);
    // O agente mexeu nos depósitos da linha: ela não acompanha mais (a conferência aponta a diferença).
    const editada = [{ ...linhas[0]!, depositos: 5, automatica: false }];
    expect(ajustarLinhaAutomatica(editada, 13, criar)).toBe(editada);
    // Total de volta a zero: a linha automática sem quantidade some; com quantidade digitada, fica.
    expect(ajustarLinhaAutomatica([criar(3)], 0, criar)).toEqual([]);
    const comQuantidade = [{ ...criar(3), qtdTexto: '2,5' }];
    expect(ajustarLinhaAutomatica(comQuantidade, 0, criar)).toBe(comQuantidade);
    // Mesmo array quando nada muda (o efeito do formulário não entra em laço) e nada sem produto no catálogo.
    const iguais = [criar(4)];
    expect(ajustarLinhaAutomatica(iguais, 4, criar)).toBe(iguais);
    expect(ajustarLinhaAutomatica([], 2, () => null)).toEqual([]);
  });

  it('quantidade guardada volta ao campo no formato brasileiro', () => {
    expect(quantidadeParaTexto(2.5)).toBe('2,5');
    expect(quantidadeParaTexto(25000)).toBe('25000');
    expect(quantidadeParaTexto(0)).toBe('');
  });
});

describe('numeração dos tubitos', () => {
  it('guarda a posição da sequência e volta de 999 para 1 sem repetir números na visita seguinte', () => {
    // Visita 1: a sequência está no 998, então começa no 999; dois tubitos: 999 e 1.
    let proximo = seguinteTubito(998);
    const a = numeroDoBotao(proximo, new Set());
    proximo = seguinteTubito(a);
    const b = numeroDoBotao(proximo, new Set([a]));
    expect([a, b]).toEqual([999, 1]);
    // Gravada a posição (o último número dado pelo botão), a visita 2 começa no 2. Gravar o maior número (999) faria a
    // visita 2 começar de novo no 1, repetindo o tubito mandado ao laboratório.
    expect(seguinteTubito(b)).toBe(2);
    expect(numeroDoBotao(5, new Set([5, 6]))).toBe(7);
    expect(seguinteTubito(0)).toBe(1);
    expect(seguinteTubito(null)).toBe(1);
    expect(seguinteTubito(1000)).toBe(1);
  });
});

/** Roda com o aparelho em outro fuso: o Node relê o TZ quando ele muda. */
function noFuso<T>(fuso: string, fn: () => T): T {
  const antes = process.env.TZ;
  process.env.TZ = fuso;
  try {
    return fn();
  } finally {
    if (antes === undefined) delete process.env.TZ;
    else process.env.TZ = antes;
  }
}

describe('ordem da visita no formulário', () => {
  // A abertura às 10 h de 5/11 no fuso do aparelho (o do processo dos testes); o campo datetime-local também é nesse fuso.
  const ordem = { id: 'o1', numero: '7/2026', abertaEm: new Date(2026, 10, 5, 10, 0).toISOString() };
  const fora = { ordemId: null, aviso: 'A data é anterior à abertura da ordem 7/2026: a visita não vai entrar nela' };

  // Antes, o formulário mandava a ordem do contexto com qualquer data e qualquer atividade, e a visita entrava nela.
  it('a visita de dia anterior ao da abertura vai sem a ordem, com o aviso; a do dia da abertura, mesmo antes da hora, vai com ela', () => {
    expect(ordemDoFormulario(ordem, 'BLOQUEIO', '2026-11-04T23:59')).toEqual(fora);
    expect(ordemDoFormulario(ordem, 'BLOQUEIO', '2026-10-30T08:00')).toEqual(fora);
    expect(ordemDoFormulario(ordem, 'BLOQUEIO', '2026-11-05T00:00')).toEqual({ ordemId: 'o1', aviso: null });
    expect(ordemDoFormulario(ordem, 'BLOQUEIO', '2026-11-05T09:59')).toEqual({ ordemId: 'o1', aviso: null });
    expect(ordemDoFormulario(ordem, 'BLOQUEIO', '2026-11-06T08:00')).toEqual({ ordemId: 'o1', aviso: null });
  });

  it('só a visita de bloqueio leva a ordem (e o alerta dela); sem ordem no contexto, nenhuma', () => {
    for (const atividade of ['LI', 'LI_T', 'T', 'PE', 'DF', 'PVE'] as const) {
      expect(ordemDoFormulario(ordem, atividade, '2026-11-06T08:00')).toEqual({ ordemId: null, aviso: null });
      // Fora do bloqueio, a data de antes da abertura não é com a ordem: sem aviso.
      expect(ordemDoFormulario(ordem, atividade, '2026-11-04T08:00')).toEqual({ ordemId: null, aviso: null });
    }
    expect(ordemDoFormulario(null, 'BLOQUEIO', '2026-11-06T08:00')).toEqual({ ordemId: null, aviso: null });
    expect(ordemDoFormulario(undefined, 'BLOQUEIO', '2026-11-04T08:00')).toEqual({ ordemId: null, aviso: null });
  });

  it('sem a abertura no contexto ou com a data ilegível, vai a ordem (o servidor confere)', () => {
    expect(ordemDoFormulario({ id: 'o1', numero: '7/2026' }, 'BLOQUEIO', '2026-11-04T08:00')).toEqual({ ordemId: 'o1', aviso: null });
    expect(ordemDoFormulario({ ...ordem, abertaEm: null }, 'BLOQUEIO', '2026-11-04T08:00')).toEqual({ ordemId: 'o1', aviso: null });
    expect(ordemDoFormulario({ ...ordem, abertaEm: 'ontem' }, 'BLOQUEIO', '2026-11-04T08:00')).toEqual({ ordemId: 'o1', aviso: null });
    expect(ordemDoFormulario(ordem, 'BLOQUEIO', '')).toEqual({ ordemId: 'o1', aviso: null });
    expect(ordemDoFormulario(ordem, 'BLOQUEIO', '2026-11-04T')).toEqual({ ordemId: 'o1', aviso: null });
  });

  it('o dia é o do fuso do aparelho, não o do UTC', () => {
    noFuso('America/Sao_Paulo', () => {
      expect(new Date('2026-11-05T03:30:00Z').getHours()).toBe(0);
      // Aberta à 0h30 de 5/11 (3h30 no UTC): a visita das 23h30 de 4/11 (2h30 de 5/11 no UTC) é do dia anterior.
      const madrugada = { ...ordem, abertaEm: '2026-11-05T03:30:00Z' };
      expect(ordemDoFormulario(madrugada, 'BLOQUEIO', '2026-11-04T23:30')).toEqual(fora);
      expect(ordemDoFormulario(madrugada, 'BLOQUEIO', '2026-11-05T00:10')).toEqual({ ordemId: 'o1', aviso: null });
      // Aberta às 23h de 4/11 (2h de 5/11 no UTC): a visita das 20h de 4/11 (23h de 4/11 no UTC) é do mesmo dia.
      const noite = { ...ordem, abertaEm: '2026-11-05T02:00:00Z' };
      expect(ordemDoFormulario(noite, 'BLOQUEIO', '2026-11-04T20:00')).toEqual({ ordemId: 'o1', aviso: null });
      expect(ordemDoFormulario(noite, 'BLOQUEIO', '2026-11-03T23:00')).toEqual(fora);
    });
  });
});

describe('efeito no pacote do que o servidor aceitou', () => {
  it('marca a visita no ciclo e na ordem, inclui o imóvel novo com o id do servidor e desconta o larvicida', () => {
    const base = pacoteBase();
    const antes = JSON.stringify(base);
    const p = aplicarAceitosNoPacote(base, [
      { op: imovelNovo('c-imovel'), id: 'h-novo' },
      { op: visita('v1', { visita: { ordemId: 'o-antiga', tratamentos: [{ produtoId: 'bti', loteId: 'l-bti', quantidade: 2.5, depositos: 1 }] } }), id: 'vv1' },
      { op: visita('v2', { householdId: null, householdClientId: 'c-imovel', visita: { situacao: 'FECHADO' } }), id: 'vv2' },
    ]);
    expect(JSON.stringify(base)).toBe(antes);
    const h1 = p.imoveis.find((i) => i.id === 'h1')!;
    expect(h1.noCiclo).toEqual({ situacao: 'TRABALHADO', em: '2026-11-07T12:00:00Z' });
    expect(p.ordens.find((o) => o.id === 'o-antiga')!.visitados.h1).toEqual({ situacao: 'TRABALHADO', em: '2026-11-07T12:00:00Z' });
    const novo = p.imoveis.find((i) => i.id === 'h-novo')!;
    expect(novo).toMatchObject({ quarteiraoId: 'q1', sequencia: '7A', endereco: 'Travessa Nova, 7', noCiclo: { situacao: 'FECHADO' } });
    expect(novo.pendente).toBeUndefined();
    expect(p.estoque[0]!.saldo).toBe(97.5);
  });

  // Antes, a visita de bloqueio sem ordem ia para a ordem mais recente do pacote, mesmo aberta depois do dia dela (o
  // servidor a grava na ordem aberta até o dia da visita, ou sem ordem): a casa aparecia visitada na ordem nova.
  it('a visita de bloqueio sem ordem marca a ordem em que o servidor a gravou, não a mais recente do pacote; fora do ciclo não marca o ciclo', () => {
    // Sem rede, o ACE visitou em 3/11, antes da abertura da o-nova (5/11): o servidor gravou na o-antiga.
    const dia3 = visita('v1', { registradoEm: '2026-11-03T12:00:00Z', visita: { atividade: 'BLOQUEIO' } });
    let p = aplicarAceitosNoPacote(pacoteBase(), [{ op: dia3, id: 'vv1', ordemId: 'o-antiga' }]);
    expect(p.ordens.find((o) => o.id === 'o-antiga')!.visitados.h1).toEqual({ situacao: 'TRABALHADO', em: '2026-11-03T12:00:00Z' });
    expect(p.ordens.find((o) => o.id === 'o-nova')!.visitados.h1).toBeUndefined();
    // De antes das duas (30/10, fora do ciclo): gravada como bloqueio sem ordem; nem as ordens nem o ciclo marcam a casa.
    const dia30 = visita('v2', { registradoEm: '2026-10-30T12:00:00Z', visita: { atividade: 'BLOQUEIO' } });
    p = aplicarAceitosNoPacote(pacoteBase(), [{ op: dia30, id: 'vv2', ordemId: null }]);
    expect(p.ordens.map((o) => o.visitados.h1)).toEqual([undefined, undefined]);
    expect(p.imoveis[0]!.noCiclo).toBeNull();
  });

  it('a informada unificada a outra marca a ordem que ficou; a cancelada, gravada sem ordem, não marca nenhuma', () => {
    const naNova = visita('v1', { visita: { atividade: 'BLOQUEIO', ordemId: 'o-nova' } });
    // A o-nova foi unificada à o-antiga depois do download do pacote: a visita ficou na o-antiga.
    let p = aplicarAceitosNoPacote(pacoteBase(), [{ op: naNova, id: 'vv1', ordemId: 'o-antiga' }]);
    expect(p.ordens.find((o) => o.id === 'o-antiga')!.visitados.h1).toEqual({ situacao: 'TRABALHADO', em: '2026-11-07T12:00:00Z' });
    expect(p.ordens.find((o) => o.id === 'o-nova')!.visitados.h1).toBeUndefined();
    // A o-nova foi cancelada: a visita ficou sem ordem; só o ciclo marca a casa.
    p = aplicarAceitosNoPacote(pacoteBase(), [{ op: naNova, id: 'vv1', ordemId: null }]);
    expect(p.ordens.map((o) => o.visitados.h1)).toEqual([undefined, undefined]);
    expect(p.imoveis[0]!.noCiclo).toEqual({ situacao: 'TRABALHADO', em: '2026-11-07T12:00:00Z' });
  });

  it('sem a ordem na resposta (servidor de antes), vale só a informada: a de bloqueio sem ordem não marca ordem nenhuma', () => {
    const semOrdem = visita('v1', { registradoEm: '2026-11-03T12:00:00Z', visita: { atividade: 'BLOQUEIO' } });
    let p = aplicarAceitosNoPacote(pacoteBase(), [{ op: semOrdem, id: 'vv1' }]);
    expect(p.ordens.map((o) => o.visitados.h1)).toEqual([undefined, undefined]);
    expect(p.imoveis[0]!.noCiclo).toEqual({ situacao: 'TRABALHADO', em: '2026-11-03T12:00:00Z' });
    const informada = visita('v2', { visita: { atividade: 'BLOQUEIO', ordemId: 'o-antiga' } });
    p = aplicarAceitosNoPacote(pacoteBase(), [{ op: informada, id: 'vv2' }]);
    expect(p.ordens.find((o) => o.id === 'o-antiga')!.visitados.h1).toEqual({ situacao: 'TRABALHADO', em: '2026-11-07T12:00:00Z' });
    expect(p.ordens.find((o) => o.id === 'o-nova')!.visitados.h1).toBeUndefined();
  });

  it('não regride: visita mais antiga não apaga a mais nova, e reaplicar o imóvel novo não duplica', () => {
    let p = aplicarAceitosNoPacote(pacoteBase(), [{ op: visita('v1', { registradoEm: '2026-11-07T15:00:00Z' }), id: 'a' }]);
    p = aplicarAceitosNoPacote(p, [{ op: visita('v0', { registradoEm: '2026-11-07T09:00:00Z', visita: { situacao: 'RECUSADO' } }), id: 'b' }]);
    expect(p.imoveis[0]!.noCiclo?.situacao).toBe('TRABALHADO');
    p = aplicarAceitosNoPacote(p, [{ op: imovelNovo('c'), id: 'h-novo' }]);
    p = aplicarAceitosNoPacote(p, [{ op: imovelNovo('c'), id: 'h-novo' }]);
    expect(p.imoveis.filter((i) => i.id === 'h-novo')).toHaveLength(1);
  });
});

describe('falhas da sincronização', () => {
  it('servidor fora, sem rede, sessão, permissão e limite interrompem o envio com o motivo; 400 e 422 são do conteúdo', () => {
    expect(classificarFalha(new ApiError(503, 'Service Unavailable'))).toBe('servidor');
    expect(classificarFalha(new ApiError(502, 'Bad Gateway'))).toBe('servidor');
    expect(classificarFalha(new ApiError(404, 'Not Found'))).toBe('servidor');
    expect(classificarFalha(new ApiError(0, 'Sem conexão'))).toBe('rede');
    expect(classificarFalha(new ApiError(408, 'Request Timeout'))).toBe('rede');
    expect(classificarFalha(new DOMException('cancelado', 'AbortError'))).toBe('rede');
    expect(classificarFalha(new ApiError(401, 'Sessão expirada'))).toBe('sessao');
    expect(classificarFalha(new ApiError(403, 'Sem permissão'))).toBe('permissao');
    expect(classificarFalha(new ApiError(429, 'Muitas requisições'))).toBe('limite');
    expect(classificarFalha(new ApiError(400, 'Dados inválidos', 'VALIDACAO'))).toBe('conteudo');
    expect(classificarFalha(new ApiError(422, 'Regra'))).toBe('conteudo');
  });

  it('400 do lote inteiro aponta a operação pelo índice, com a mensagem real', () => {
    const lote = [{ clientId: 'a' }, { clientId: 'b' }, { clientId: 'c' }];
    const porOp = errosPorOperacao(
      [
        { path: 'operacoes.1.visita.amostras.0.larvas', message: 'Number must be less than or equal to 999' },
        { path: 'operacoes.1.visita.observacoes', message: 'String must contain at most 1000 character(s)' },
      ],
      lote,
    );
    expect(porOp).toEqual(new Map([['b', 'Dados inválidos: visita.amostras.0.larvas: Number must be less than or equal to 999; visita.observacoes: String must contain at most 1000 character(s)']]));
    // Detalhe que não aponta operação (o envelope): sem mapa, todas levam a mensagem do servidor.
    expect(errosPorOperacao([{ path: 'operacoes', message: 'Array must contain at most 100 element(s)' }], lote)).toBeNull();
    expect(errosPorOperacao([{ path: 'operacoes.7.visita', message: 'x' }], lote)).toBeNull();
    expect(errosPorOperacao(undefined, lote)).toBeNull();
  });
});
