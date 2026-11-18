import { ROTULO_STATUS_IMPORTACAO, type DetalheImportacao, type ImportacaoDoMesmoArquivo, type ResultadoAplicacao } from '@omnisaude/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  iniciarAcompanhamento,
  MENSAGEM_IMPORTACAO_OCUPADA,
  MENSAGEM_SERVIDOR_OCUPADO,
  mensagemDoErro,
  proximoPasso,
  resumoDaAplicacao,
  situacaoImportacao,
  textoSubstituidaPor,
} from '../src/components/consolidacao/importacao-regras';
import { api, ApiError, errorMessage } from '../src/lib/api';

/*
 * Aba Importação (web), quarta rodada: o 409 do servidor ocupado com envios de outros municípios mostra a mensagem da
 * API, e só o da importação do próprio município manda acompanhar no histórico (N2); a importação substituída pela
 * aplicação mais recente do mesmo arquivo tem a situação própria no histórico, diz no detalhe por qual envio foi
 * substituída e continua com o resultado da aplicação dela (aviso-periodo-lido). fetch simulado; dados sintéticos.
 */

afterEach(() => vi.unstubAllGlobals());

/** O erro que o envio (POST cru) lança com a resposta simulada. */
async function erroDoEnvio(resposta: () => Response): Promise<ApiError> {
  vi.stubGlobal('fetch', async () => resposta());
  try {
    await api.post('/vigilancia/importacoes?nome=x.dbf', new Blob([new Uint8Array(10)]), { raw: true, token: null, headers: { 'Content-Type': 'application/octet-stream' } });
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('o envio deveria falhar');
}

describe('N2: os 409 do servidor ocupado e o da importação do município', () => {
  const SERVIDOR = 'O servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.';
  const DO_MUNICIPIO = 'Outro envio da sua instituição está sendo recebido agora. Tente de novo quando ele terminar.';

  it('IMPORTACAO_SERVIDOR_OCUPADO mostra a mensagem da API (o histórico do município pode estar vazio), no envio e no aplicar', async () => {
    for (const mensagem of [SERVIDOR, DO_MUNICIPIO]) {
      const e = await erroDoEnvio(() => Response.json({ statusCode: 409, code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: mensagem }, { status: 409 }));
      expect(e).toMatchObject({ status: 409, code: 'IMPORTACAO_SERVIDOR_OCUPADO' });
      expect(mensagemDoErro('enviar', { status: e.status, code: e.code, message: errorMessage(e) })).toBe(mensagem);
      expect(mensagemDoErro('aplicar', { status: e.status, code: e.code, message: errorMessage(e) })).toBe(mensagem);
    }
    // Sem a mensagem da API, o texto pronto do servidor ocupado (nunca o de acompanhar no histórico).
    expect(mensagemDoErro('enviar', { status: 409, code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: ' ' })).toBe(MENSAGEM_SERVIDOR_OCUPADO);
    expect(MENSAGEM_SERVIDOR_OCUPADO).toBe(SERVIDOR);
  });

  it('IMPORTACAO_OCUPADA (outra importação do próprio município lendo ou aplicando) continua mandando acompanhar no histórico', async () => {
    const e = await erroDoEnvio(() => Response.json({ code: 'IMPORTACAO_OCUPADA', message: 'Outra importação está sendo processada agora. Tente de novo em alguns minutos.' }, { status: 409 }));
    expect(mensagemDoErro('enviar', { status: e.status, code: e.code, message: errorMessage(e) })).toBe(MENSAGEM_IMPORTACAO_OCUPADA);
    expect(MENSAGEM_IMPORTACAO_OCUPADA).toContain('Acompanhe no histórico');
  });
});

describe('aviso-periodo-lido: a importação substituída pelo envio mais recente do mesmo arquivo', () => {
  const dataHora = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
  const substituta: ImportacaoDoMesmoArquivo = {
    id: 'imp-2',
    enviadaEm: '2026-11-17T13:05:00.000Z',
    aplicadaEm: '2026-11-17T13:07:00.000Z',
    periodo: { de: '2026-01-01', ate: '2026-12-31' },
    periodoDeclarado: true,
  };
  const resultado: ResultadoAplicacao = {
    id: 'imp-1',
    aplicadoEm: '2026-11-16T12:00:00.000Z',
    contagens: { lidos: 2, novos: 2, alterados: 0, iguais: 0, recusados: 0, duplicadosNoArquivo: 0, ausentesPrevistos: 2, motivosRecusa: {}, porTipo: { INDIVIDUAL: 2 } },
    ausentesMarcados: 2,
    voltaram: 0,
    unidadesLigadas: 2,
    vinculadosAutomaticamente: 0,
    negativasCanceladas: 0,
    avisos: [],
  };
  const detalhe = (d: Partial<DetalheImportacao> = {}): DetalheImportacao => ({
    id: 'imp-1',
    sistema: 'SINAN_ONLINE',
    status: 'SUBSTITUIDA',
    arquivo: 'DENGON2026.DBF',
    tamanhoBytes: 100,
    periodo: { de: '2025-01-01', ate: '2025-12-31' },
    periodoDeclarado: true,
    identificado: true,
    contagens: resultado.contagens,
    criadoEm: '2026-11-16T11:58:00.000Z',
    criadoPor: 'Vera',
    aplicadoEm: '2026-11-16T12:00:00.000Z',
    aplicadoPor: 'Vera',
    descartadoEm: null,
    descartadoPor: null,
    expirada: false,
    processamento: null,
    erro: null,
    resultadoAplicacao: resultado,
    substituidaPor: substituta,
    sha256: 'a'.repeat(64),
    arquivos: [],
    previa: null,
    avisos: [],
    expiraEm: null,
    ...d,
  });

  it('no histórico, a situação "Substituída"; no detalhe, por qual envio do mesmo arquivo, com a data', () => {
    expect(ROTULO_STATUS_IMPORTACAO.SUBSTITUIDA).toBe('Substituída');
    expect(situacaoImportacao({ status: 'SUBSTITUIDA', expirada: false })).toEqual({ rotulo: 'Substituída', tom: 'slate' });
    expect(textoSubstituidaPor(detalhe(), dataHora)).toBe(
      'Substituída pelo envio do mesmo arquivo de 17/11/2026 13:05 (período 01/01/2026 a 31/12/2026, declarado), aplicado em 17/11/2026 13:07. A cobertura e os ausentes passaram a ser os dele.',
    );
    // Só na SUBSTITUIDA.
    expect(textoSubstituidaPor(detalhe({ status: 'APLICADA', substituidaPor: null }), dataHora)).toBeNull();
  });

  it('o resultado da aplicação continua valendo: o acompanhamento a mostra como aplicada; o resumo da que substituiu diz quantos voltaram', () => {
    expect(proximoPasso(iniciarAcompanhamento('APLICACAO'), { ok: true, detalhe: detalhe() })).toMatchObject({ tipo: 'aplicada', resultado });
    const nova: ResultadoAplicacao = {
      ...resultado,
      id: 'imp-2',
      ausentesMarcados: 0,
      substituidas: [{ id: 'imp-1', enviadaEm: '2026-11-16T11:58:00.000Z', aplicadaEm: '2026-11-16T12:00:00.000Z', periodo: { de: '2025-01-01', ate: '2025-12-31' }, periodoDeclarado: true, voltaram: 2 }],
    };
    expect(resumoDaAplicacao(nova, dataHora)).toContain(
      'Substituiu a aplicação do mesmo arquivo enviada em 16/11/2026 11:58 (período 01/01/2025 a 31/12/2025, declarado): a cobertura passou a ser a deste envio e 2 registro(s) que ela deu como ausentes voltaram.',
    );
    // O resultado gravado antes da regra (sem `substituidas`) continua com o resumo de sempre.
    expect(resumoDaAplicacao(resultado, dataHora)).toEqual([
      '2 registro(s) novo(s) e 0 alterado(s) gravados.',
      '2 registro(s) do mesmo período não vieram e ficaram marcados como ausentes.',
      '2 registro(s) ligados à unidade pelo CNES.',
    ]);
  });
});
