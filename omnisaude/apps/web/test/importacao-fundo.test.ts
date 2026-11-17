import type { ArquivoDetectado, DetalheImportacao, ResultadoAplicacao } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import {
  ACOMPANHAMENTO,
  aplicacaoEmAndamento,
  avisoPeriodoLido,
  envioEmProcessamento,
  iniciarAcompanhamento,
  MENSAGEM_APLICAR_SEM_RESPOSTA,
  MENSAGEM_ENVIO_SEM_RESPOSTA,
  MENSAGEM_IMPORTACAO_OCUPADA,
  mensagemDoErro,
  mensagemDoErroGravado,
  proximoPasso,
  situacaoImportacao,
  TEXTO_LIMITES_ENVIO,
  type EstadoAcompanhamento,
  type PassoAcompanhamento,
} from '../src/components/consolidacao/importacao-regras';

/*
 * Aba Importação (web), segunda rodada: a leitura e a aplicação continuam no servidor depois do 202 e a tela acompanha
 * o detalhe (máquina de estados pura, sem React), as mensagens prontas da resposta que não chegou e da vez ocupada, os
 * selos do histórico e o aviso do período lido das notificações no arquivo de um agravo só.
 */

const contagens = { lidos: 2, novos: 2, alterados: 0, iguais: 0, recusados: 0, duplicadosNoArquivo: 0, ausentesPrevistos: 0, motivosRecusa: {}, porTipo: { INDIVIDUAL: 2 } };
const resultado: ResultadoAplicacao = {
  id: 'imp-1',
  aplicadoEm: '2026-11-16T12:00:00.000Z',
  contagens,
  ausentesMarcados: 0,
  voltaram: 0,
  unidadesLigadas: 2,
  vinculadosAutomaticamente: 0,
  negativasCanceladas: 0,
  avisos: [],
};
const arquivo = (tipo: ArquivoDetectado['tipo'], ignorado = false): ArquivoDetectado => ({
  nome: `${tipo}.dbf`,
  tipo,
  sistema: 'SINAN_NET',
  tipoRegistro: 'INDIVIDUAL',
  tamanhoBytes: 100,
  registros: 2,
  codificacao: 'CP850',
  origemCodificacao: 'CABECALHO',
  agravos: ['A279'],
  periodo: { de: '2025-03-10', ate: '2025-08-20' },
  identificado: true,
  ignorado,
  avisos: [],
});
const detalhe = (d: Partial<DetalheImportacao> = {}): DetalheImportacao => ({
  id: 'imp-1',
  sistema: 'SINAN_NET',
  status: 'PREVIA',
  arquivo: 'LEPTO.DBF',
  tamanhoBytes: 100,
  periodo: { de: '2025-03-10', ate: '2025-08-20' },
  periodoDeclarado: false,
  identificado: true,
  contagens,
  criadoEm: '2026-11-16T11:00:00.000Z',
  criadoPor: 'Vera',
  aplicadoEm: null,
  aplicadoPor: null,
  descartadoEm: null,
  descartadoPor: null,
  expirada: false,
  processamento: null,
  erro: null,
  resultadoAplicacao: null,
  substituidaPor: null,
  sha256: 'a'.repeat(64),
  arquivos: [arquivo('NINDINET')],
  previa: null,
  avisos: [],
  expiraEm: '2026-11-17T11:00:00.000Z',
  ...d,
});
const lendo = detalhe({ status: 'PROCESSANDO', sistema: null, contagens: null, processamento: { etapa: 'LENDO', desde: '2026-11-16T11:00:00.000Z', atualizadoEm: '2026-11-16T11:00:15.000Z' } });
const aplicando = detalhe({ processamento: { etapa: 'APLICANDO', desde: '2026-11-16T11:05:00.000Z', atualizadoEm: '2026-11-16T11:05:15.000Z' } });
const ok = (d: DetalheImportacao) => ({ ok: true as const, detalhe: d });
const falha = (status: number, mensagem = 'Sem conexão com o servidor.') => ({ ok: false as const, status, mensagem });
const esperar = (p: PassoAcompanhamento): Extract<PassoAcompanhamento, { tipo: 'esperar' }> => {
  if (p.tipo !== 'esperar') throw new Error(`esperava continuar, veio ${p.tipo}`);
  return p;
};

describe('acompanhamento da leitura (depois do 202 do envio)', () => {
  it('consulta a cada 2 s com recuo até 5 s enquanto lê; PREVIA abre a prévia; FALHOU mostra a mensagem gravada', () => {
    let e: EstadoAcompanhamento = iniciarAcompanhamento('LEITURA');
    expect(e).toEqual({ alvo: 'LEITURA', intervaloMs: 2000, falhas: 0 });
    const intervalos: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = esperar(proximoPasso(e, ok(lendo)));
      expect(p.detalhe).toBe(lendo);
      expect(p.aviso).toBeNull();
      e = p.estado;
      intervalos.push(e.intervaloMs);
    }
    expect(intervalos).toEqual([3000, 4500, 5000, 5000, 5000]);
    expect(proximoPasso(e, ok(detalhe()))).toEqual({ tipo: 'previa', detalhe: detalhe() });
    const falhou = detalhe({ status: 'FALHOU', sistema: null, contagens: null, erro: { codigo: 'SEM_REGISTROS', mensagem: 'Nenhum registro válido no envio (3 recusado(s)).' } });
    expect(proximoPasso(e, ok(falhou))).toEqual({ tipo: 'falhou', detalhe: falhou, mensagem: 'Nenhum registro válido no envio (3 recusado(s)).' });
    // Interrompida (o servidor reiniciou): a mensagem é a gravada pela API.
    const interrompida = detalhe({ status: 'FALHOU', erro: { codigo: 'LEITURA_INTERROMPIDA', mensagem: 'A leitura do arquivo foi interrompida (o servidor reiniciou). Envie o arquivo de novo.' } });
    expect(proximoPasso(e, ok(interrompida))).toMatchObject({ tipo: 'falhou', mensagem: expect.stringContaining('servidor reiniciou') });
  });

  it('falha de rede passageira (0, 502, 503, 504, 524) não interrompe: avisa a partir da segunda e para só depois do limite', () => {
    let e = iniciarAcompanhamento('LEITURA');
    for (const status of [0, 502, 503, 504, 524]) {
      const p = esperar(proximoPasso(e, falha(status)));
      expect(p.detalhe).toBeNull();
      expect(p.estado.falhas).toBe(e.falhas + 1);
      expect(p.aviso).toBe(p.estado.falhas >= ACOMPANHAMENTO.falhasParaAvisar ? 'Sem resposta do servidor agora; tentando de novo…' : null);
      e = p.estado;
    }
    // A resposta boa zera as falhas.
    e = esperar(proximoPasso(e, ok(lendo))).estado;
    expect(e.falhas).toBe(0);
    for (let i = 0; i < ACOMPANHAMENTO.falhasToleradas; i++) e = esperar(proximoPasso(e, falha(524))).estado;
    expect(proximoPasso(e, falha(524))).toEqual({ tipo: 'parar', mensagem: 'O servidor não responde. O trabalho pode continuar lá: confira o histórico em alguns minutos.' });
    // Erro que não é passageiro (importação apagada, sem permissão): para na hora com a mensagem da API.
    expect(proximoPasso(iniciarAcompanhamento('LEITURA'), falha(404, 'Importação não encontrado(a)'))).toEqual({ tipo: 'parar', mensagem: 'Importação não encontrado(a)' });
  });
});

describe('acompanhamento da aplicação (depois do 202 do aplicar)', () => {
  it('continua com a marca APLICANDO; APLICADA traz o resultado guardado; PREVIA com erro volta aplicável', () => {
    const e = iniciarAcompanhamento('APLICACAO');
    expect(esperar(proximoPasso(e, ok(aplicando))).estado.intervaloMs).toBe(3000);
    // Já gravada, ainda reconciliando a negativa: a marca continua e a tela espera o resultado final.
    expect(proximoPasso(e, ok(detalhe({ status: 'APLICADA', processamento: aplicando.processamento })))).toMatchObject({ tipo: 'esperar' });
    const aplicada = detalhe({ status: 'APLICADA', resultadoAplicacao: resultado, aplicadoEm: resultado.aplicadoEm });
    expect(proximoPasso(e, ok(aplicada))).toEqual({ tipo: 'aplicada', detalhe: aplicada, resultado });
    const comErro = detalhe({ erro: { codigo: 'APLICACAO_INTERROMPIDA', mensagem: 'A aplicação foi interrompida antes de terminar; nada foi gravado. Aplique de novo.' } });
    expect(proximoPasso(e, ok(comErro))).toEqual({ tipo: 'falhou', detalhe: comErro, mensagem: 'A aplicação foi interrompida antes de terminar; nada foi gravado. Aplique de novo.' });
    expect(proximoPasso(e, ok(detalhe()))).toMatchObject({ tipo: 'falhou', mensagem: 'A aplicação não terminou. Confira a prévia e aplique de novo.' });
    expect(proximoPasso(e, ok(detalhe({ status: 'DESCARTADA', expirada: true })))).toMatchObject({ tipo: 'falhou' });
  });
});

describe('respostas do envio e do aplicar', () => {
  it('202 do envio e do aplicar são reconhecidos pelo corpo (a API devolve o mesmo formato de sempre no 201 e no 200)', () => {
    expect(envioEmProcessamento({ id: 'x', status: 'PROCESSANDO', arquivo: 'a.zip', tamanhoBytes: 10, desde: '2026-11-16T11:00:00.000Z' })).toBe(true);
    expect(envioEmProcessamento(detalhe())).toBe(false);
    expect(envioEmProcessamento({ jaImportado: { id: 'x', aplicadoEm: '2026-11-16T11:00:00.000Z' } })).toBe(false);
    expect(aplicacaoEmAndamento({ id: 'x', status: 'APLICANDO' })).toBe(true);
    expect(aplicacaoEmAndamento(resultado)).toBe(false);
  });

  it('resposta que não chegou (rede, 502, 503, 504, 524) e vez ocupada têm mensagem pronta; o resto mostra a da API', () => {
    for (const status of [0, 502, 503, 504, 524]) {
      expect(mensagemDoErro('enviar', { status, message: 'Erro 524' })).toBe('A resposta não chegou. Se o arquivo foi recebido, a prévia aparece no histórico em instantes.');
      expect(mensagemDoErro('aplicar', { status, message: 'Erro 524' })).toBe(MENSAGEM_APLICAR_SEM_RESPOSTA);
    }
    expect(MENSAGEM_ENVIO_SEM_RESPOSTA).toBe('A resposta não chegou. Se o arquivo foi recebido, a prévia aparece no histórico em instantes.');
    expect(mensagemDoErro('enviar', { status: 409, code: 'IMPORTACAO_OCUPADA', message: 'Outra importação está sendo processada agora.' })).toBe(MENSAGEM_IMPORTACAO_OCUPADA);
    expect(mensagemDoErro('aplicar', { status: 409, code: 'IMPORTACAO_OCUPADA', message: 'x' })).toBe(MENSAGEM_IMPORTACAO_OCUPADA);
    expect(mensagemDoErro('enviar', { status: 422, code: 'SEM_REGISTROS', message: 'Nenhum registro válido no envio.' })).toBe('Nenhum registro válido no envio.');
    expect(mensagemDoErro('enviar', { status: 500, message: 'Erro interno' })).toBe('Erro interno');
  });

  it('texto do envio com os tetos da API', () => {
    expect(TEXTO_LIMITES_ENVIO).toBe('Zip, DBF ou CSV de até 95 MB (até 150 MB descompactados e 400 mil registros por envio)');
  });
});

describe('histórico', () => {
  it('selos de Lendo, Aplicando e Falhou, com a mensagem gravada', () => {
    expect(situacaoImportacao(lendo)).toEqual({ rotulo: 'Lendo o arquivo…', tom: 'violet' });
    expect(situacaoImportacao(aplicando)).toEqual({ rotulo: 'Aplicando…', tom: 'violet' });
    expect(situacaoImportacao(detalhe({ status: 'APLICADA', processamento: aplicando.processamento }))).toEqual({ rotulo: 'Aplicando…', tom: 'violet' });
    const falhou = detalhe({ status: 'FALHOU', erro: { codigo: 'SEM_REGISTROS', mensagem: 'Nenhum registro válido no envio.' } });
    expect(situacaoImportacao(falhou)).toEqual({ rotulo: 'Falhou', tom: 'red' });
    expect(mensagemDoErroGravado(falhou)).toBe('Nenhum registro válido no envio.');
    expect(mensagemDoErroGravado(detalhe({ erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno ao aplicar; nada foi gravado.' } }))).toBe(
      'A última tentativa de aplicar não terminou: Erro interno ao aplicar; nada foi gravado.',
    );
    expect(mensagemDoErroGravado(detalhe())).toBeNull();
    expect(mensagemDoErroGravado({ ...falhou, status: 'DESCARTADA' })).toBeNull();
    // Os selos de antes continuam.
    expect(situacaoImportacao({ status: 'PREVIA', expirada: false })).toEqual({ rotulo: 'Prévia', tom: 'blue' });
    expect(situacaoImportacao({ status: 'DESCARTADA', expirada: true })).toEqual({ rotulo: 'Expirada', tom: 'amber' });
  });
});

describe('período lido das notificações (aviso-periodo-lido)', () => {
  const texto =
    'O período foi lido das notificações: de 10/03/2025 até 20/08/2025. Se a exportação cobriu mais, por exemplo o ano inteiro, descarte e envie de novo ' +
    'declarando o período: as semanas fora do período lido ficam fora do canal endêmico.';

  it('na prévia do DBF do agravo ou do CSV do e-SUS Sinan sem período declarado, avisa com as datas lidas', () => {
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('AGRAVO_NET')] }))).toBe(texto);
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('ESUS_SINAN_CSV')] }))).toBe(texto);
    // Dois agravos (dois DBFs de agravo) e a tabela ignorada no zip: continua valendo.
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('AGRAVO_NET'), arquivo('AGRAVO_NET'), arquivo('TABELA_SINAN', true)] }))).toBe(texto);
    // O DENGON também é de um agravo só (a regra mudou na terceira rodada: o consolidado usa o período lido dele).
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('DENGON')] }))).toBe(texto);
  });

  it('sem aviso: período declarado, NINDINET (todos os agravos) junto, outro tipo, sem período ou fora da prévia', () => {
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('AGRAVO_NET')], periodoDeclarado: true }))).toBeNull();
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('NINDINET'), arquivo('AGRAVO_NET')] }))).toBeNull();
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('NNEGANET')] }))).toBeNull();
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('AGRAVO_NET')], periodo: null }))).toBeNull();
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('AGRAVO_NET')], status: 'APLICADA' }))).toBeNull();
    expect(avisoPeriodoLido(detalhe({ arquivos: [arquivo('TABELA_SINAN', true)] }))).toBeNull();
  });
});
