import type { ArquivoDetectado, ContagensImportacao, DetalheImportacao, ResultadoAplicacao } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import {
  codificacoesParaTrocar,
  conferirArquivo,
  conferirPeriodo,
  consultaDoEnvio,
  detalhesDoErroDeEnvio,
  fmtBytes,
  formatoDoArquivo,
  jaImportado,
  LIMITE_ENVIO_BYTES,
  linhasDasContagens,
  motivosOrdenados,
  resumoDaAplicacao,
  situacaoImportacao,
  textoExpiracao,
  textoPorTipo,
} from '../src/components/consolidacao/importacao-regras';

/*
 * Aba Importação (web): conferência do arquivo e do período antes do envio, consulta do POST, contagens da prévia,
 * troca de codificação e resumo da aplicação.
 */

const contagens: ContagensImportacao = {
  lidos: 130,
  novos: 100,
  alterados: 10,
  iguais: 15,
  recusados: 3,
  duplicadosNoArquivo: 2,
  ausentesPrevistos: 0,
  motivosRecusa: { 'Data da notificação futura': 1, 'Sem número da notificação': 2 },
  porTipo: { INDIVIDUAL: 120, NEGATIVA: 5 },
};

const arquivo = (nome: string, tipo: ArquivoDetectado['tipo'], ignorado = false) => ({ nome, tipo, ignorado });

describe('antes do envio', () => {
  it('aceita zip, DBF e CSV até 95 MB; recusa o resto com a explicação', () => {
    expect(conferirArquivo({ name: 'DENGON2026.zip', size: 10 })).toBeNull();
    expect(conferirArquivo({ name: 'NINDINET.DBF', size: 10 })).toBeNull();
    expect(conferirArquivo({ name: 'notificacoes.csv', size: 10 })).toBeNull();
    expect(conferirArquivo({ name: 'planilha.xlsx', size: 10 })).toContain('.zip, .dbf ou .csv');
    expect(conferirArquivo({ name: 'sem-extensao', size: 10 })).toContain('.zip, .dbf ou .csv');
    expect(conferirArquivo({ name: 'vazio.csv', size: 0 })).toBe('O arquivo está vazio.');
    expect(conferirArquivo({ name: 'grande.zip', size: LIMITE_ENVIO_BYTES + 1 })).toBe('O arquivo passa de 95 MB: exporte por período menor.');
  });

  it('período declarado: os dois ou nenhum, e o início antes do fim', () => {
    expect(conferirPeriodo('', '')).toBeNull();
    expect(conferirPeriodo('2026-01-01', '2026-12-31')).toBeNull();
    expect(conferirPeriodo('2026-01-01', '')).toBe('Informe o início e o fim do período, ou deixe os dois em branco.');
    expect(conferirPeriodo('2026-12-31', '2026-01-01')).toBe('O início do período vem depois do fim.');
  });

  it('consulta do envio: nome codificado; período só com as duas datas; codificação só quando escolhida', () => {
    expect(consultaDoEnvio({ nome: 'Exportação SINAN.zip' })).toBe('?nome=Exporta%C3%A7%C3%A3o+SINAN.zip');
    expect(consultaDoEnvio({ nome: 'a.dbf', de: '2026-01-01', ate: '2026-06-30', codificacao: 'CP850' })).toBe('?nome=a.dbf&de=2026-01-01&ate=2026-06-30&codificacao=CP850');
    expect(consultaDoEnvio({ nome: 'a.dbf', de: '2026-01-01', ate: '', codificacao: '' })).toBe('?nome=a.dbf');
    expect(new URLSearchParams(consultaDoEnvio({ nome: `${'x'.repeat(300)}.zip` }).slice(1)).get('nome')).toHaveLength(255);
  });

  it('tamanho legível', () => {
    expect(fmtBytes(830)).toBe('830 bytes');
    expect(fmtBytes(12_800)).toBe('12,5 KB');
    expect(fmtBytes(LIMITE_ENVIO_BYTES)).toBe('95 MB');
  });
});

describe('prévia', () => {
  it('reconhece o arquivo já importado (nada foi criado)', () => {
    expect(jaImportado({ jaImportado: { id: 'x', aplicadoEm: '2026-11-01T10:00:00.000Z' } })).toBe(true);
    expect(jaImportado({ id: 'y' } as DetalheImportacao)).toBe(false);
  });

  it('situação na lista: a prévia descartada pelo tempo aparece como expirada', () => {
    expect(situacaoImportacao({ status: 'PREVIA', expirada: false })).toEqual({ rotulo: 'Prévia', tom: 'blue' });
    expect(situacaoImportacao({ status: 'APLICADA', expirada: false })).toEqual({ rotulo: 'Aplicada', tom: 'green' });
    expect(situacaoImportacao({ status: 'DESCARTADA', expirada: true })).toEqual({ rotulo: 'Expirada', tom: 'amber' });
    expect(situacaoImportacao({ status: 'DESCARTADA', expirada: false })).toEqual({ rotulo: 'Descartada', tom: 'slate' });
  });

  it('contagens na ordem da tela, com destaque para recusados, duplicados e ausentes', () => {
    const l = linhasDasContagens(contagens);
    expect(l.map((x) => [x.rotulo, x.valor, x.tom])).toEqual([
      ['Lidos', 130, 'default'],
      ['Novos', 100, 'good'],
      ['Alterados', 10, 'default'],
      ['Iguais', 15, 'default'],
      ['Recusados', 3, 'bad'],
      ['Duplicados no arquivo', 2, 'warn'],
      ['Ausentes previstos', 0, 'default'],
    ]);
    expect(textoPorTipo(contagens.porTipo)).toBe('Individual: 120 · Negativa: 5');
    expect(textoPorTipo({})).toBe('');
    expect(motivosOrdenados(contagens.motivosRecusa)).toEqual([
      { motivo: 'Sem número da notificação', quantidade: 2 },
      { motivo: 'Data da notificação futura', quantidade: 1 },
    ]);
  });

  it('tempo até a prévia expirar', () => {
    const agora = new Date('2026-11-10T10:00:00.000Z');
    expect(textoExpiracao('2026-11-11T09:10:00.000Z', agora)).toBe('Expira em 23 h 10 min.');
    expect(textoExpiracao('2026-11-10T10:05:30.000Z', agora)).toBe('Expira em 5 min.');
    expect(textoExpiracao('2026-11-10T09:59:00.000Z', agora)).toBe('A prévia expirou: envie o arquivo de novo.');
    expect(textoExpiracao(null, agora)).toBeNull();
  });

  it('codificações para reprocessar: as do DBF, as do CSV, ou as duas num zip misto (arquivo ignorado não conta)', () => {
    expect(codificacoesParaTrocar([arquivo('NINDINET.DBF', 'NINDINET')])).toEqual(['CP850', 'CP437', 'CP860', 'CP1252']);
    expect(codificacoesParaTrocar([arquivo('notifica.csv', 'ESUS_NOTIFICA_CSV')])).toEqual(['UTF8', 'CP1252']);
    expect(codificacoesParaTrocar([arquivo('DENGON.dbf', 'DENGON'), arquivo('x.csv', 'ESUS_SINAN_CSV')])).toEqual(['CP850', 'CP437', 'CP860', 'CP1252', 'UTF8']);
    expect(codificacoesParaTrocar([arquivo('MUNICNET.DBF', 'TABELA_SINAN', true)])).toEqual([]);
    expect(formatoDoArquivo(arquivo('sem-ext', 'ESUS_SINAN_CSV'))).toBe('CSV');
    expect(formatoDoArquivo(arquivo('sem-ext', 'DESCONHECIDO'))).toBeNull();
  });
});

describe('depois de aplicar e no erro', () => {
  it('resumo da aplicação só com o que aconteceu', () => {
    const r: ResultadoAplicacao = {
      id: 'x',
      aplicadoEm: '2026-11-10T10:00:00.000Z',
      contagens,
      ausentesMarcados: 4,
      voltaram: 0,
      unidadesLigadas: 90,
      vinculadosAutomaticamente: 12,
      negativasCanceladas: 1,
      avisos: [],
    };
    expect(resumoDaAplicacao(r)).toEqual([
      '100 registro(s) novo(s) e 10 alterado(s) gravados.',
      '4 registro(s) do mesmo período não vieram e ficaram marcados como ausentes.',
      '90 registro(s) ligados à unidade pelo CNES.',
      '12 vínculo(s) automático(s) com as notificações do OmniSaúde.',
      '1 atesto(s) de notificação negativa cancelado(s): a unidade tinha caso na semana.',
    ]);
  });

  it('erro sem registros: mostra os arquivos detectados e os motivos; qualquer outro formato vira listas vazias', () => {
    const d = detalhesDoErroDeEnvio({ arquivos: [{ nome: 'MUNICNET.DBF', tipo: 'TABELA_SINAN' }, null, { tipo: 'x' }], motivosRecusa: { 'Data futura': 3, ruim: 'x' } });
    expect(d.arquivos.map((a) => a.nome)).toEqual(['MUNICNET.DBF']);
    expect(d.motivos).toEqual([{ motivo: 'Data futura', quantidade: 3 }]);
    expect(detalhesDoErroDeEnvio(undefined)).toEqual({ arquivos: [], motivos: [] });
    expect(detalhesDoErroDeEnvio([{ path: 'x', message: 'y' }])).toEqual({ arquivos: [], motivos: [] });
  });
});
