import type { ArquivoDetectado, DetalheImportacao } from '@omnisaude/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertaDoErroDeEnvio, avisoPeriodoLido, caminhoDoAcompanhamento, comPreviaCarregada, lerAcompanhamento, MENSAGEM_ENVIO_SEM_RESPOSTA, mensagemDoErro } from '../src/components/consolidacao/importacao-regras';
import { MENSAGEM_SERVIDOR_DEMOROU } from '../src/lib/api';

/*
 * Aba Importação (web), terceira rodada: o aviso do período lido em todo arquivo de um agravo ou de uma ficha
 * (aviso-periodo-lido), o alerta da resposta do envio que não chegou (TELAS-5) e o acompanhamento sem a prévia nominal,
 * mantendo na tela a prévia já carregada (TELAS-1). Dados sintéticos.
 */

const arquivo = (tipo: ArquivoDetectado['tipo'], ignorado = false): ArquivoDetectado => ({
  nome: `${tipo}.dbf`,
  tipo,
  sistema: tipo === 'DENGON' || tipo === 'CHIKON' ? 'SINAN_ONLINE' : tipo === 'ESUS_NOTIFICA_CSV' ? 'ESUS_NOTIFICA' : 'SINAN_NET',
  tipoRegistro: 'INDIVIDUAL',
  tamanhoBytes: 100,
  registros: 3,
  codificacao: 'CP850',
  origemCodificacao: 'CABECALHO',
  agravos: [],
  cnes: null,
  periodo: { de: '2025-03-04', ate: '2025-03-18' },
  identificado: true,
  ignorado,
  avisos: [],
});

const previa = {
  novos: [{ chave: 'k1', tipo: 'INDIVIDUAL', numero: '1', notificadoEm: '2025-03-04', agravo: 'A90', grupo: 'dengue', cnes: null, situacao: 'EM_INVESTIGACAO', paciente: 'PACIENTE SINTETICO', sigiloso: false }],
  alterados: [],
  recusados: [],
  duplicados: [],
  ausentes: [],
} as DetalheImportacao['previa'];

const detalhe = (d: Partial<DetalheImportacao> = {}): DetalheImportacao => ({
  id: 'imp-1',
  sistema: 'SINAN_ONLINE',
  status: 'PREVIA',
  arquivo: 'DENGON2025.DBF',
  tamanhoBytes: 100,
  periodo: { de: '2025-03-04', ate: '2025-03-18' },
  periodoDeclarado: false,
  identificado: true,
  contagens: { lidos: 3, novos: 3, alterados: 0, iguais: 0, recusados: 0, duplicadosNoArquivo: 0, ausentesPrevistos: 0, motivosRecusa: {}, porTipo: { INDIVIDUAL: 3 } },
  criadoEm: '2026-11-17T10:00:00.000Z',
  criadoPor: 'Vera',
  aplicadoEm: null,
  aplicadoPor: null,
  descartadoEm: null,
  descartadoPor: null,
  expirada: false,
  processamento: null,
  erro: null,
  resultadoAplicacao: null,
  sha256: 'a'.repeat(64),
  arquivos: [arquivo('DENGON')],
  previa: null,
  avisos: [],
  expiraEm: '2026-11-18T10:00:00.000Z',
  ...d,
});

afterEach(() => vi.unstubAllGlobals());

describe('aviso-periodo-lido: todo arquivo de um agravo ou de uma ficha sem período declarado', () => {
  const texto =
    'O período foi lido das notificações: de 04/03/2025 até 18/03/2025. Se a exportação cobriu mais, por exemplo o ano inteiro, descarte e envie de novo ' +
    'declarando o período: as semanas fora do período lido ficam fora do canal endêmico.';

  it('avisa no DENGON, no CHIKON, no CSV do e-SUS Notifica e no zip com o DBF do agravo e o DENGON', () => {
    for (const tipos of [['DENGON'], ['CHIKON'], ['ESUS_NOTIFICA_CSV'], ['AGRAVO_NET', 'DENGON'], ['NINDINET', 'DENGON'], ['NNEGANET', 'AGRAVO_NET']] as ArquivoDetectado['tipo'][][])
      expect(avisoPeriodoLido(detalhe({ arquivos: tipos.map((t) => arquivo(t)) })), tipos.join('+')).toBe(texto);
  });

  it('não avisa no NINDINET (todos os agravos), nem no DBF do agravo junto com ele, nem na negativa ou no surto sozinhos', () => {
    for (const tipos of [['NINDINET'], ['NINDINET', 'AGRAVO_NET'], ['NNEGANET'], ['NSURTNET']] as ArquivoDetectado['tipo'][][])
      expect(avisoPeriodoLido(detalhe({ arquivos: tipos.map((t) => arquivo(t)) })), tipos.join('+')).toBeNull();
    expect(avisoPeriodoLido(detalhe({ periodoDeclarado: true }))).toBeNull();
  });
});

describe('TELAS-5: a resposta do envio que não chegou', () => {
  it('0, 502, 503, 504 e 524: alerta de aviso com o título "A resposta do envio não chegou" e a mensagem de esperar o histórico', () => {
    for (const status of [0, 502, 503, 504, 524]) {
      expect(alertaDoErroDeEnvio(status), String(status)).toEqual({ tom: 'warn', titulo: 'A resposta do envio não chegou' });
      expect(mensagemDoErro('enviar', { status, message: 'x' })).toBe(MENSAGEM_ENVIO_SEM_RESPOSTA);
    }
  });

  it('o resto é erro do envio: "O envio não gerou prévia"', () => {
    for (const status of [400, 409, 413, 422, 500, undefined, null]) expect(alertaDoErroDeEnvio(status), String(status)).toEqual({ tom: 'error', titulo: 'O envio não gerou prévia' });
  });
});

describe('TELAS-1: o acompanhamento não relê a prévia nominal', () => {
  it('a consulta do acompanhamento usa ?acompanhar=1', async () => {
    const pedidos: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      pedidos.push(url);
      return Response.json(detalhe({ processamento: { etapa: 'APLICANDO', desde: '2026-11-17T10:05:00.000Z', atualizadoEm: '2026-11-17T10:05:15.000Z' } }));
    });
    expect(caminhoDoAcompanhamento('imp-1')).toBe('/vigilancia/importacoes/imp-1?acompanhar=1');
    const leitura = await lerAcompanhamento('imp-1');
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatch(/\/vigilancia\/importacoes\/imp-1\?acompanhar=1$/);
    expect(leitura).toMatchObject({ ok: true, detalhe: { status: 'PREVIA', processamento: { etapa: 'APLICANDO' } } });
  });

  it('a falha passageira da consulta vem com o status (a máquina de estados tolera e tenta de novo)', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>524</html>', { status: 524, headers: { 'content-type': 'text/html' } }));
    expect(await lerAcompanhamento('imp-1')).toEqual({ ok: false, status: 524, mensagem: MENSAGEM_SERVIDOR_DEMOROU });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await lerAcompanhamento('imp-1')).toMatchObject({ ok: false, status: 0 });
  });

  it('a prévia que a tela já tem continua enquanto a importação é uma prévia; aplicada ou de outra importação, sai', () => {
    const carregada = detalhe({ previa });
    const aplicando = detalhe({ processamento: { etapa: 'APLICANDO', desde: '2026-11-17T10:05:00.000Z', atualizadoEm: '2026-11-17T10:05:15.000Z' } });
    expect(comPreviaCarregada(carregada, aplicando)).toEqual({ ...aplicando, previa });
    // A aplicação que não terminou volta aplicável com a mesma prévia na tela.
    const falhou = detalhe({ erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno ao aplicar; nada foi gravado.' } });
    expect(comPreviaCarregada(carregada, falhou).previa).toBe(previa);
    expect(comPreviaCarregada(carregada, detalhe({ status: 'APLICADA', aplicadoEm: '2026-11-17T10:06:00.000Z' })).previa).toBeNull();
    expect(comPreviaCarregada(carregada, detalhe({ status: 'DESCARTADA' })).previa).toBeNull();
    expect(comPreviaCarregada(carregada, detalhe({ id: 'imp-2' })).previa).toBeNull();
    expect(comPreviaCarregada(null, aplicando)).toBe(aplicando);
    // A prévia nova (o detalhe completo) vale mais que a da tela.
    const nova = { ...previa!, novos: [] };
    expect(comPreviaCarregada(carregada, detalhe({ previa: nova })).previa).toBe(nova);
  });
});
