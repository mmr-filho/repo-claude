import type { ArquivoDetectado } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import { arquivoCobre, cnesDoArquivo, gruposDoArquivo, periodoCoberto } from '../src/modules/vigilancia/cobertura-importacao';
import { divergenciasDoPar, evolucaoComparavel } from '../src/modules/vigilancia/conciliacao.service';

/**
 * Regras da conciliação sem banco (VIG-1c, frente A2 da semana 27): a evolução traduzida pela ficha antes de comparar
 * o registro oficial com a notificação do OmniSaúde (achado imp-mpox-codigos), a cobertura de cada arquivo por grupo
 * (achado imp-cobertura-so-omni) e, na terceira rodada, os grupos do mesmo agravo do Sinan (conciliacao-2), o CNES
 * único do arquivo (imp-cobertura-so-omni) e o fim do período na data do envio (conciliacao-3).
 */

const arquivo = (a: Partial<ArquivoDetectado> & Pick<ArquivoDetectado, 'tipo' | 'sistema'>): ArquivoDetectado => ({
  nome: 'x',
  tipoRegistro: 'INDIVIDUAL',
  tamanhoBytes: 1,
  registros: 1,
  codificacao: 'CP850',
  origemCodificacao: 'CABECALHO',
  agravos: [],
  cnes: null,
  periodo: { de: '2026-01-01', ate: '2026-01-31' },
  identificado: true,
  ignorado: false,
  avisos: [],
  ...a,
});

describe('Conciliação: evolução traduzida pela ficha antes de comparar (imp-mpox-codigos)', () => {
  const notificacao = (evolution: string | null) => ({ status: 'ENCERRADA', finalClass: '1', evolution, closedAt: new Date('2026-03-20T00:00:00Z') });
  const mpox = (evolution: string | null) => ({ system: 'ESUS_SINAN', agravo: 'B04', situation: 'CONFIRMADO', evolution, closedOn: new Date('2026-03-20T00:00:00Z') });

  it('Mpox no e-SUS Sinan: óbito oficial (1) contra cura no OmniSaúde (1) diverge; cura oficial (2) contra cura (1) não', () => {
    expect(divergenciasDoPar(mpox('1'), notificacao('1'))).toEqual([{ campo: 'evolucao', oficial: '2', omnisaude: '1' }]);
    expect(divergenciasDoPar(mpox('2'), notificacao('1'))).toEqual([]);
    // Óbito dos dois lados: nada a apontar.
    expect(divergenciasDoPar(mpox('1'), notificacao('2'))).toEqual([]);
    expect(evolucaoComparavel(mpox('3'))).toBe('3');
    expect(evolucaoComparavel(mpox('9'))).toBe('9');
  });

  it('as outras fichas: Sinan Net padrão como veio, e-SUS Notifica pela numeração de lá, óbito pelo agravo em outro código vira 2', () => {
    expect(evolucaoComparavel({ system: 'SINAN_NET', agravo: 'A279', evolution: '2' })).toBe('2');
    expect(evolucaoComparavel({ system: 'SINAN_NET', agravo: 'A279', evolution: '01' })).toBe('1');
    expect(evolucaoComparavel({ system: 'ESUS_NOTIFICA', agravo: null, evolution: '6' })).toBe('9');
    expect(evolucaoComparavel({ system: 'ESUS_NOTIFICA', agravo: null, evolution: '4' })).toBeNull();
    // Tuberculose: EVOLUCAO 3 é o óbito por tuberculose (o 2 do OmniSaúde); o 2 de lá não é óbito.
    expect(evolucaoComparavel({ system: 'SINAN_NET', agravo: 'A169', evolution: '3' })).toBe('2');
    expect(evolucaoComparavel({ system: 'SINAN_NET', agravo: 'A169', evolution: '2' })).toBeNull();
    expect(divergenciasDoPar({ system: 'SINAN_NET', agravo: 'A169', situation: 'CONFIRMADO', evolution: '3', closedOn: null }, { status: 'ENCERRADA', finalClass: '1', evolution: '2', closedAt: null })).toEqual([]);
    expect(evolucaoComparavel({ system: 'SINAN_NET', agravo: 'A279', evolution: null })).toBeNull();
  });
});

describe('Conciliação: cobertura de cada arquivo por grupo (imp-cobertura-so-omni)', () => {
  it('o DBF do agravo e o CSV do e-SUS Sinan cobrem só os agravos que vieram; só o NINDINET cobre o sistema inteiro', () => {
    const lepto = arquivo({ tipo: 'AGRAVO_NET', sistema: 'SINAN_NET', agravos: ['A279'] });
    expect(gruposDoArquivo(lepto)).toEqual(['leptospirose']);
    expect(arquivoCobre(lepto, 'coqueluche')).toBe(false);
    expect(arquivoCobre(lepto, 'leptospirose')).toBe(true);
    const mpox = arquivo({ tipo: 'ESUS_SINAN_CSV', sistema: 'ESUS_SINAN', agravos: ['B04'] });
    expect(gruposDoArquivo(mpox)).toEqual(['mpox']);
    expect(arquivoCobre(mpox, 'oropouche')).toBe(false);
    const nindinet = arquivo({ tipo: 'NINDINET', sistema: 'SINAN_NET', agravos: ['A279'] });
    expect(gruposDoArquivo(nindinet)).toBeNull();
    expect(arquivoCobre(nindinet, 'coqueluche')).toBe(true);
    // Dengue vai para o Sinan Online: o NINDINET só a cobre se trouxe o agravo.
    expect(arquivoCobre(nindinet, 'dengue')).toBe(false);
    expect(arquivoCobre({ ...nindinet, agravos: ['A90'] }, 'dengue')).toBe(true);
  });

  it('DENGON e CHIKON cobrem o seu agravo; o e-SUS Notifica, a ficha (do arquivo ou dos registros gravados); arquivo ignorado não cobre', () => {
    expect(gruposDoArquivo(arquivo({ tipo: 'DENGON', sistema: 'SINAN_ONLINE' }))).toEqual(['dengue']);
    expect(gruposDoArquivo(arquivo({ tipo: 'CHIKON', sistema: 'SINAN_ONLINE', agravos: ['A920'] }))).toEqual(['chikungunya']);
    const sg = arquivo({ tipo: 'ESUS_NOTIFICA_CSV', sistema: 'ESUS_NOTIFICA' });
    expect(gruposDoArquivo(sg)).toEqual([]);
    expect(gruposDoArquivo(sg, ['covid'])).toEqual(['covid']);
    expect(gruposDoArquivo({ ...sg, grupos: ['esavi'] }, ['covid'])).toEqual(['esavi']);
    expect(arquivoCobre(sg, 'esavi', ['covid'])).toBe(false);
    expect(gruposDoArquivo(arquivo({ tipo: 'NINDINET', sistema: 'SINAN_NET', ignorado: true }))).toEqual([]);
    expect(gruposDoArquivo(arquivo({ tipo: 'NNEGANET', sistema: 'SINAN_NET', tipoRegistro: 'NEGATIVA' }))).toEqual([]);
  });
});

describe('Conciliação: grupos do mesmo agravo do Sinan, CNES do arquivo e fim no envio (terceira rodada)', () => {
  it('conciliacao-2: o DBF do Y09 cobre a violência sexual e a tentativa de suicídio na conciliação; no consolidado, só a violência', () => {
    const y09 = arquivo({ tipo: 'AGRAVO_NET', sistema: 'SINAN_NET', agravos: ['Y09'] });
    expect(gruposDoArquivo(y09)).toEqual(['violencia', 'violencia-sexual-suicidio']);
    // Os registros do Y09 ficam todos no grupo "violencia": a base consolidada da violência sexual não os conta.
    expect(arquivoCobre(y09, 'violencia')).toBe(true);
    expect(arquivoCobre(y09, 'violencia-sexual-suicidio')).toBe(false);
    // Os outros agravos não ganham grupo nenhum.
    expect(gruposDoArquivo(arquivo({ tipo: 'AGRAVO_NET', sistema: 'SINAN_NET', agravos: ['A279', 'O981'] }))).toEqual(['leptospirose', 'sifilis']);
    expect(gruposDoArquivo(arquivo({ tipo: 'ESUS_NOTIFICA_CSV', sistema: 'ESUS_NOTIFICA', grupos: ['covid'] }))).toEqual(['covid']);
  });

  it('imp-cobertura-so-omni: o CNES único do arquivo, lido com tolerância (arquivo antigo sem o campo vale null)', () => {
    const sg = arquivo({ tipo: 'ESUS_NOTIFICA_CSV', sistema: 'ESUS_NOTIFICA', grupos: ['covid'] });
    const { cnes: _, ...antigo } = sg;
    expect(cnesDoArquivo(antigo as ArquivoDetectado)).toBeNull();
    expect(cnesDoArquivo(sg)).toBeNull();
    expect(cnesDoArquivo({ ...sg, cnes: '9000036' })).toBe('9000036');
    expect(cnesDoArquivo({ ...sg, cnes: '  ' })).toBeNull();
  });

  it('conciliacao-3: o período coberto termina no menor entre o fim (declarado ou lido) e a data local do envio', () => {
    const tz = 'America/Sao_Paulo';
    const lido = { periodo: { de: '2026-01-05', ate: '2026-11-30' } };
    const imp = (createdAt: string, declarado?: [string, string]) => ({
      periodFrom: declarado ? new Date(`${declarado[0]}T00:00:00Z`) : null,
      periodTo: declarado ? new Date(`${declarado[1]}T00:00:00Z`) : null,
      declaredPeriod: !!declarado,
      createdAt: new Date(createdAt),
    });
    // O ano inteiro declarado, enviado em 16/11 às 20h de Brasília: cobre até 16/11, não até 31/12.
    expect(periodoCoberto(imp('2026-11-16T23:00:00Z', ['2026-01-01', '2026-12-31']), lido, tz)).toEqual({ de: '2026-01-01', ate: '2026-11-16' });
    // A data do envio é a do fuso do tenant: 01h30 UTC de 17/11 ainda é 16/11 em Brasília (e 17/11 em Lisboa).
    expect(periodoCoberto(imp('2026-11-17T01:30:00Z', ['2026-01-01', '2026-12-31']), lido, tz)!.ate).toBe('2026-11-16');
    expect(periodoCoberto(imp('2026-11-17T01:30:00Z', ['2026-01-01', '2026-12-31']), lido, 'Europe/Lisbon')!.ate).toBe('2026-11-17');
    // Sem período declarado, vale o lido no arquivo, também limitado ao envio; o fim antes do envio fica como está.
    expect(periodoCoberto(imp('2026-11-16T15:00:00Z'), lido, tz)).toEqual({ de: '2026-01-05', ate: '2026-11-16' });
    expect(periodoCoberto(imp('2026-12-20T15:00:00Z'), lido, tz)).toEqual({ de: '2026-01-05', ate: '2026-11-30' });
    // Período que começa depois do envio não cobre nada; arquivo sem período também não.
    expect(periodoCoberto(imp('2026-11-16T15:00:00Z', ['2026-12-01', '2026-12-31']), lido, tz)).toBeNull();
    expect(periodoCoberto(imp('2026-11-16T15:00:00Z'), { periodo: null }, tz)).toBeNull();
  });
});
