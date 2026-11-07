import { describe, expect, it } from 'vitest';
import {
  avisoLimiteOrdens,
  avisoLimitePendencias,
  depositoSugerido,
  fmtIndice,
  fmtPercentual,
  fmtQuantidade,
  lerQuantidadeEntrada,
  lotesParaResolver,
  marcarAgente,
  opcoesDesignacao,
  opcoesTitular,
  pedidoAcaoOrdem,
  temDistancia,
  textoAgravos,
  textoDistancia,
  textoMinimoAcao,
  textoSeraLancado,
  textoTentativas,
  trocarAcaoOrdem,
  valorEntre,
} from '../src/components/endemias/gestao-regras';
import type { AgenteEndemias, DepositoEndemias, LoteDeposito } from '../src/components/endemias/types';
import { indicesDaContagem } from '@omnisaude/shared';

/*
 * Regras das telas de gestão das endemias (web): o que a revisão da semana 26 achou nas telas da supervisão e da gestão.
 */

describe('ordem de bloqueio: o que deriva do ponto do caso só aparece quando vem (sigilo)', () => {
  it('sem a distância (gestão e supervisão), a coluna some e nada vira "0 m"', () => {
    const daGestao = [
      { distanciaM: null, numero: '18' },
      { distanciaM: null, numero: '17' },
    ];
    expect(temDistancia(daGestao)).toBe(false);
    expect(textoDistancia(null)).toBe('—');
    expect(temDistancia([{ distanciaM: 0 }, { distanciaM: 74.4 }])).toBe(true);
    expect(textoDistancia(74.4)).toBe('74 m');
    expect(textoDistancia(1234.6)).toBe('1.235 m');
  });

  it('os agravos só aparecem quando a API manda (vazio para quem não vê o mapa de casos)', () => {
    expect(textoAgravos([])).toBe('');
    expect(textoAgravos(['dengue', 'zika', 'outro'])).toBe('Dengue, Zika, outro');
  });
});

describe('lista de ordens com teto de 500', () => {
  it('avisa só quando a lista vem cheia, com o critério de cada situação', () => {
    expect(avisoLimiteOrdens('ATIVAS', 499)).toBeNull();
    expect(avisoLimiteOrdens('ATIVAS', 500)).toMatch(/^Mostrando as 500 mais urgentes: as atrasadas primeiro/);
    expect(avisoLimiteOrdens('ENCERRADAS', 500)).toBe('Mostrando as 500 mais recentes.');
    expect(avisoLimiteOrdens('TODAS', 500)).toBe('Mostrando as 500 mais recentes.');
  });
});

describe('ação na ordem: a justificativa da conclusão não vira motivo do cancelamento', () => {
  it('Voltar e trocar de ação limpam o texto; o cancelamento sai com o motivo vazio, não com a justificativa', () => {
    let estado = trocarAcaoOrdem('concluir');
    estado = { ...estado, texto: 'Ficaram três imóveis fechados depois de duas tentativas' };
    estado = trocarAcaoOrdem(null); // Voltar
    expect(estado).toEqual({ acao: null, texto: '' });
    estado = trocarAcaoOrdem('cancelar');
    expect(estado.texto).toBe('');
    expect(pedidoAcaoOrdem('o1', 'cancelar', estado.texto, [])).toEqual({ caminho: '/endemias/bloqueios/o1/cancelar', corpo: { motivo: '' } });
    // Trocar direto de uma ação para outra também começa do zero.
    expect(trocarAcaoOrdem('reabrir').texto).toBe('');
  });

  it('o mínimo de texto é o da API: motivo de 5 caracteres; a conclusão só exige 10 se ficou imóvel sem visita ou pendente', () => {
    expect(textoMinimoAcao('cancelar', { semVisita: 0, pendentes: 0 })).toBe(5);
    expect(textoMinimoAcao('reabrir', { semVisita: 0, pendentes: 0 })).toBe(5);
    expect(textoMinimoAcao('concluir', { semVisita: 0, pendentes: 0 })).toBe(0);
    expect(textoMinimoAcao('concluir', { semVisita: 2, pendentes: 0 })).toBe(10);
    expect(textoMinimoAcao('concluir', { semVisita: 0, pendentes: 1 })).toBe(10);
    expect(textoMinimoAcao('designar', { semVisita: 5, pendentes: 5 })).toBe(0);
  });

  it('cada ação vai para a sua rota com o seu corpo', () => {
    expect(pedidoAcaoOrdem('o1', 'concluir', '   ', [])).toEqual({ caminho: '/endemias/bloqueios/o1/concluir', corpo: { nota: null } });
    expect(pedidoAcaoOrdem('o1', 'reabrir', ' Faltou o quarteirão 12 ', [])).toEqual({ caminho: '/endemias/bloqueios/o1/reabrir', corpo: { motivo: 'Faltou o quarteirão 12' } });
    expect(pedidoAcaoOrdem('o1', 'designar', 'texto ignorado', ['a', 'b'])).toEqual({ caminho: '/endemias/bloqueios/o1/agentes', corpo: { agentes: ['a', 'b'] } });
  });
});

const agente = (id: string, nome: string, unidades = ['Vigilância em Saúde']): AgenteEndemias => ({ id, nome, papeis: ['ACE'], unidades });

describe('designar agentes: o designado sem lotação ativa aparece para ser tirado', () => {
  const rafael = agente('u-rafael', 'Rafael Souza');
  const silvia = agente('u-silvia', 'Sílvia Moura');
  const transferido = { id: 'u-transferido', nome: 'Agente transferido' };

  it('as caixas são a união dos elegíveis com os designados; o inelegível vem primeiro e marcado', () => {
    const opcoes = opcoesDesignacao([rafael, silvia], [{ id: rafael.id, nome: rafael.nome }, transferido]);
    expect(opcoes.map((o) => [o.id, o.elegivel])).toEqual([
      ['u-transferido', false],
      ['u-rafael', true],
      ['u-silvia', true],
    ]);
  });

  it('o cenário da revisão: marcar a Sílvia e desmarcar o transferido envia só os elegíveis', () => {
    const opcoes = opcoesDesignacao([rafael, silvia], [{ id: rafael.id, nome: rafael.nome }, transferido]);
    const [fora, , comSilvia] = opcoes;
    let escolhidos = [rafael.id, transferido.id];
    escolhidos = marcarAgente(escolhidos, comSilvia!, true);
    expect(escolhidos).toEqual([rafael.id, transferido.id, silvia.id]);
    escolhidos = marcarAgente(escolhidos, fora!, false);
    expect(escolhidos).toEqual([rafael.id, silvia.id]);
    // Quem está sem lotação ativa só sai: não volta a ser marcado.
    expect(marcarAgente(escolhidos, fora!, true)).toEqual([rafael.id, silvia.id]);
    expect(pedidoAcaoOrdem('o1', 'designar', '', escolhidos).corpo).toEqual({ agentes: [rafael.id, silvia.id] });
  });

  it('designado sem nome e lista vazia de elegíveis', () => {
    expect(opcoesDesignacao([], [{ id: 'x', nome: null }])).toEqual([{ id: 'x', nome: 'Agente sem nome', unidades: [], elegivel: false }]);
  });

  it('zona: o titular fora da lista vira a opção "(nome) — sem lotação ativa", e o campo mostra o que vai ser enviado', () => {
    const opcoes = opcoesTitular([rafael], transferido);
    expect(opcoes[0]).toEqual({ id: 'u-transferido', rotulo: 'Agente transferido — sem lotação ativa', semLotacao: true });
    expect(valorEntre('u-transferido', opcoes)).toBe('u-transferido');
    // Titular elegível: nenhuma opção a mais.
    expect(opcoesTitular([rafael, silvia], { id: rafael.id, nome: rafael.nome }).map((o) => o.id)).toEqual([rafael.id, silvia.id]);
    // Enquanto a lista carrega, o titular aparece sem o aviso; sem titular, só os agentes.
    expect(opcoesTitular(null, transferido)).toEqual([{ id: 'u-transferido', rotulo: 'Agente transferido', semLotacao: false }]);
    expect(opcoesTitular([rafael], null).map((o) => o.id)).toEqual([rafael.id]);
  });
});

describe('entrada por remessa no formato brasileiro', () => {
  it('"25.000" são 25 mil (a tela antiga lia 25) e a tela mostra o que será lançado', () => {
    const antes = Number('25.000'.replace(',', '.'));
    expect(antes).toBe(25);
    const lida = lerQuantidadeEntrada('25.000');
    expect(lida).toEqual({ valor: 25000, erro: null });
    expect(textoSeraLancado(lida.valor!, 'G')).toBe('Será lançado: 25.000 G');
  });

  it('milhar com decimais, vírgula decimal e número sem separador', () => {
    expect(lerQuantidadeEntrada('1.000,5').valor).toBe(1000.5);
    expect(lerQuantidadeEntrada('2.500,000').valor).toBe(2500);
    expect(lerQuantidadeEntrada('25,5').valor).toBe(25.5);
    expect(lerQuantidadeEntrada(' 25000 ').valor).toBe(25000);
    expect(textoSeraLancado(1000.5, 'G')).toBe('Será lançado: 1.000,5 G');
  });

  it('o ambíguo e o inválido não são lançados e dizem por quê', () => {
    expect(lerQuantidadeEntrada('2.5')).toEqual({ valor: null, erro: expect.stringMatching(/^Quantidade ambígua: use vírgula/) });
    expect(lerQuantidadeEntrada('1.5000').erro).toMatch(/^Quantidade ambígua/);
    expect(lerQuantidadeEntrada('25 kg').erro).toMatch(/^Quantidade inválida/);
    expect(lerQuantidadeEntrada('-3').erro).toMatch(/^Quantidade inválida/);
    expect(lerQuantidadeEntrada('0').erro).toBe('A quantidade precisa ser maior que zero');
    expect(lerQuantidadeEntrada('0,0001').erro).toBe('A quantidade mínima é 0,001');
    expect(lerQuantidadeEntrada('10.000.001').erro).toBe('A quantidade máxima por entrada é 10.000.000');
    expect(lerQuantidadeEntrada('10.000.000').valor).toBe(10_000_000);
    expect(lerQuantidadeEntrada('   ')).toEqual({ valor: null, erro: null });
  });

  it('quantidade do estoque com até três casas', () => {
    expect(fmtQuantidade(25000)).toBe('25.000');
    expect(fmtQuantidade(4918.5)).toBe('4.918,5');
    expect(fmtQuantidade(0.12345)).toBe('0,123');
  });
});

const dep = (id: string, unidade: string): DepositoEndemias => ({ id, nome: 'Depósito de Endemias', unidade, unitId: `unit-${id}` });
const lote = (loteId: string, numero: string, depositoId: string, saldo: number, extra: Partial<LoteDeposito> = {}): LoteDeposito => ({
  loteId,
  lote: numero,
  validade: '2027-03-31',
  vencido: false,
  fabricacao: null,
  depositoId,
  deposito: 'Depósito de Endemias',
  unidade: depositoId === 'd-vig' ? 'Vigilância em Saúde' : 'UBS Norte',
  saldo,
  ...extra,
});

describe('resolver baixa pendente: a supervisão escolhe o depósito e o lote desse depósito', () => {
  const depositos = [dep('d-vig', 'Vigilância em Saúde'), dep('d-norte', 'UBS Norte')];
  const lotes = [lote('l-1', 'BTI-01', 'd-vig', 4918.5), lote('l-2', 'BTI-02', 'd-vig', 10, { vencido: true, validade: '2026-01-31' }), lote('l-1', 'BTI-01', 'd-norte', 300), lote('l-3', 'BTI-03', 'd-norte', 50)];
  // T9 da revisão: ACE lotado na UBS Centro, sem depósito de endemias; a baixa ficou SEM_DEPOSITO.
  const semDeposito = { depositoId: null, unidadeVisita: 'UBS Centro', loteId: 'l-1', lote: 'BTI-01', quantidade: 20, unidade: 'G' };

  it('sem depósito na baixa nem na unidade da visita, nada vem escolhido: a supervisão escolhe', () => {
    expect(depositoSugerido(semDeposito, depositos)).toBe('');
    expect(lotesParaResolver({ acao: 'BAIXAR', lotes, depositoId: '', baixa: semDeposito })).toEqual([]);
  });

  it('sugere o depósito da baixa; senão, o único da unidade da visita', () => {
    expect(depositoSugerido({ depositoId: 'd-norte', unidadeVisita: 'UBS Centro' }, depositos)).toBe('d-norte');
    expect(depositoSugerido({ depositoId: null, unidadeVisita: 'Vigilância em Saúde' }, depositos)).toBe('d-vig');
    // Duas unidades com o mesmo nome: não adivinha.
    expect(depositoSugerido({ depositoId: null, unidadeVisita: 'UBS Norte' }, [...depositos, dep('d-norte-2', 'UBS Norte')])).toBe('');
    // Depósito que não está mais no painel cai para a unidade da visita.
    expect(depositoSugerido({ depositoId: 'd-sumiu', unidadeVisita: 'Vigilância em Saúde' }, depositos)).toBe('d-vig');
  });

  it('BAIXAR: só lotes do produto com saldo no depósito escolhido; o que não cobre a quantidade fica desabilitado', () => {
    const noVig = lotesParaResolver({ acao: 'BAIXAR', lotes, depositoId: 'd-vig', baixa: semDeposito });
    expect(noVig.map((l) => [l.id, l.desabilitado])).toEqual([
      ['l-1', false],
      ['l-2', true],
    ]);
    expect(noVig[0]!.rotulo).toBe('BTI-01 · saldo 4.918,5 G · validade 31/03/2027');
    expect(noVig[1]!.rotulo).toBe('BTI-02 · saldo 10 G · validade 31/01/2026 (vencido) · saldo insuficiente');
    // Lote de outro depósito não serve para baixar neste.
    expect(valorEntre('l-3', noVig)).toBe('');
    expect(valorEntre('l-2', noVig)).toBe('');
    expect(valorEntre('l-1', noVig)).toBe('l-1');
    expect(lotesParaResolver({ acao: 'BAIXAR', lotes, depositoId: 'd-norte', baixa: semDeposito }).map((l) => l.id)).toEqual(['l-1', 'l-3']);
  });

  it('REGULARIZAR: qualquer lote do produto, com o saldo no depósito escolhido, a começar pelo lote da visita', () => {
    const opcoes = lotesParaResolver({ acao: 'REGULARIZAR', lotes, depositoId: 'd-norte', baixa: { ...semDeposito, loteId: 'l-2', lote: 'BTI-02' } });
    expect(opcoes.map((l) => l.id)).toEqual(['l-2', 'l-1', 'l-3']);
    expect(opcoes[0]!.rotulo).toBe('BTI-02 · saldo neste depósito 0 G · validade 31/01/2026 (vencido)');
    expect(opcoes.every((l) => !l.desabilitado)).toBe(true);
    // Lote anotado na visita que não está em nenhum depósito: entra como opção própria.
    const novo = lotesParaResolver({ acao: 'REGULARIZAR', lotes, depositoId: 'd-vig', baixa: { ...semDeposito, loteId: 'l-9', lote: 'BTI-09' } });
    expect(novo[0]).toEqual({ id: 'l-9', rotulo: 'BTI-09 · lote da visita, sem saldo nos depósitos', desabilitado: false });
  });

  it('o depósito escolhido só vale se for um depósito de endemias da lista', () => {
    expect(valorEntre('d-vig', depositos)).toBe('d-vig');
    expect(valorEntre('d-farmacia', depositos)).toBe('');
  });
});

describe('pendências de visita', () => {
  it('mostra as recusas à parte do imóvel fechado e do abandono', () => {
    expect(textoTentativas({ tentativas: 2, fechados: 0, recusas: 2 })).toBe('2 recusas');
    expect(textoTentativas({ tentativas: 3, fechados: 1, recusas: 1 })).toBe('1 com o imóvel fechado · 1 recusa · 1 abandonado');
    expect(textoTentativas({ tentativas: 2, fechados: 2, recusas: 0 })).toBe('2 com o imóvel fechado');
  });

  it('avisa quando a lista vem no teto de 2.000 imóveis', () => {
    expect(avisoLimitePendencias(1999)).toBeNull();
    expect(avisoLimitePendencias(2000)).toBe('Mostrando os 2.000 imóveis com a última visita mais recente: recupere estes para ver os demais.');
  });
});

describe('índices com duas casas no formato brasileiro', () => {
  it('formata como a Nota Informativa nº 11/2026', () => {
    expect(fmtIndice(0.99)).toBe('0,99');
    expect(fmtIndice(1)).toBe('1,00');
    expect(fmtIndice(25)).toBe('25,00');
    expect(fmtIndice(1234.5)).toBe('1.234,50');
    expect(fmtIndice(null)).toBe('—');
    expect(fmtPercentual(3.9)).toBe('3,90%');
    expect(fmtPercentual(null)).toBe('—');
  });

  it('1 imóvel com foco em 101 aparece "0,99%" ao lado de Satisfatório (nunca "1%")', () => {
    const i = indicesDaContagem({ imoveisInspecionados: 101, imoveisComFoco: 1, depositosInspecionados: 300, depositosComFoco: 1, focoPorTipo: { A2: 1 } });
    expect(i.classe).toBe('SATISFATORIO');
    expect(fmtPercentual(i.iip)).toBe('0,99%');
    const alerta = indicesDaContagem({ imoveisInspecionados: 101, imoveisComFoco: 4, depositosInspecionados: 300, depositosComFoco: 4, focoPorTipo: { A2: 4 } });
    expect([alerta.classe, fmtPercentual(alerta.iip)]).toEqual(['ALERTA', '3,96%']);
  });
});
