import { describe, expect, it } from 'vitest';
import {
  AGRAVOS_SINAN,
  agravoSinanDaChave,
  gravidadeOficial,
  infoAgravoSinan,
  LNNC_NACIONAL,
  mesmoAgravoSinan,
  normalizarAgravo,
  numeroOficialValido,
  PRAZOS_ENCERRAMENTO_REFERENCIA,
  SISTEMA_INFO,
  situacaoOficial,
  situacaoOmni,
} from '@omnisaude/shared';

/** Tabela de agravos dos sistemas oficiais (VIG-1c, §3.1 do desenho) e as correções do §1 vindas da pesquisa. */
describe('agravos do Sinan: código normalizado', () => {
  it('maiúsculas, sem ponto, espaço e hífen', () => {
    expect(normalizarAgravo('a92.0')).toBe('A920');
    expect(normalizarAgravo(' b 09 ')).toBe('B09');
    expect(normalizarAgravo('G03-9')).toBe('G039');
    expect(normalizarAgravo('A92.')).toBe('A92');
    expect(normalizarAgravo('')).toBeNull();
    expect(normalizarAgravo('   ')).toBeNull();
    expect(normalizarAgravo(null)).toBeNull();
    expect(normalizarAgravo(undefined)).toBeNull();
  });

  it("no CHIKON, 'A92', 'A92.', 'A920' e 'A92.0' viram 'A920'; no DENGON, 'A90'", () => {
    for (const v of ['A92', 'A92.', 'A920', 'A92.0', 'a92.0']) expect(normalizarAgravo(v, 'CHIKON')).toBe('A920');
    // Fora do CHIKON, 'A92.' é ambíguo (chikungunya ou Zika) e não casa com nenhum agravo.
    expect(normalizarAgravo('A92.', 'NINDINET')).toBe('A92');
    expect(infoAgravoSinan('A92.')).toBeNull();
    for (const v of ['A90', 'A90.', 'A90.0']) expect(normalizarAgravo(v, 'DENGON')).toBe('A90');
    expect(normalizarAgravo('A92.0', 'DENGON')).toBe('A920');
    expect(normalizarAgravo('A928', 'CHIKON')).toBe('A928');
  });
});

describe('agravos do Sinan: tabela', () => {
  it('cobre os agravos da pesquisa, com grupo do catálogo e fonte', () => {
    const esperados: Record<string, string | null> = {
      A90: 'dengue',
      A920: 'chikungunya',
      A928: 'zika',
      A959: 'febre-amarela',
      A279: 'leptospirose',
      A379: 'coqueluche',
      G039: 'meningites',
      B09: 'sarampo-rubeola',
      B19: 'hepatites-virais',
      O981: 'sifilis',
      A509: 'sifilis',
      A539: 'sifilis',
      A169: 'tuberculose',
      A309: 'hanseniase',
      Y09: 'violencia',
      X29: 'acidente-animal-peconhento',
      W64: 'atendimento-antirrabico',
      T659: 'intoxicacao-exogena',
      A009: 'colera',
      A923: 'nilo-ocidental-arboviroses',
      J11: 'influenza-novo-subtipo',
      A969: 'febres-hemorragicas',
      B54: 'malaria',
      A209: 'peste',
      A809: 'polio-pfa',
      A829: 'raiva-humana',
      P350: 'rubeola-congenita',
      A930: 'oropouche',
      B42: 'esporotricose',
      A08: null,
    };
    for (const [codigo, grupo] of Object.entries(esperados)) expect(AGRAVOS_SINAN[codigo]?.grupo, codigo).toBe(grupo);
    const grupos = new Set(LNNC_NACIONAL.flatMap((v) => v.conditions.map((c) => c.group)));
    for (const [codigo, info] of Object.entries(AGRAVOS_SINAN)) {
      expect(codigo).toBe(normalizarAgravo(codigo));
      if (info.grupo !== null) expect(grupos.has(info.grupo), `${codigo} → ${info.grupo}`).toBe(true);
      expect(info.nome.length).toBeGreaterThan(2);
      expect(info.fonte.length).toBeGreaterThan(10);
    }
  });

  it('o código com subcategoria cai no de 3 caracteres', () => {
    expect(infoAgravoSinan('B01.9')?.grupo).toBe('varicela');
    expect(infoAgravoSinan('A92.0')?.grupo).toBe('chikungunya');
    expect(infoAgravoSinan('A150')).toBeNull();
    expect(infoAgravoSinan(null)).toBeNull();
  });
});

describe('agravos do Sinan: situação e gravidade pela classificação final', () => {
  it('dengue e chikungunya (Sinan Online): 5 descartado; CRITERIO 3 em investigação', () => {
    expect(situacaoOficial('A90', '5')).toBe('DESCARTADO');
    expect(situacaoOficial('A90', '10')).toBe('CONFIRMADO');
    expect(situacaoOficial('A90', '12')).toBe('CONFIRMADO');
    expect(situacaoOficial('A90', '8')).toBe('INCONCLUSIVO');
    expect(situacaoOficial('A90', '')).toBe('EM_INVESTIGACAO');
    expect(situacaoOficial('A90', null)).toBe('EM_INVESTIGACAO');
    expect(situacaoOficial('A90', '10', '3')).toBe('EM_INVESTIGACAO');
    expect(situacaoOficial('A90', '10', '1')).toBe('CONFIRMADO');
    // O 2 não é descarte na dengue.
    expect(situacaoOficial('A90', '2')).toBe('CONFIRMADO');
    expect(situacaoOficial('A92.0', '5')).toBe('DESCARTADO');
    expect(situacaoOficial('A920', '13', '3')).toBe('EM_INVESTIGACAO');
    // Zeros e espaços do DBF.
    expect(situacaoOficial('A90', '05')).toBe('DESCARTADO');
    expect(situacaoOficial('A90', ' 5 ')).toBe('DESCARTADO');
  });

  it('o descarte muda de agravo para agravo', () => {
    // Padrão: 2 descartado, 8 inconclusivo; CRITERIO 3 é "clínico", não "em investigação".
    expect(situacaoOficial('A379', '2')).toBe('DESCARTADO');
    expect(situacaoOficial('A379', '1', '3')).toBe('CONFIRMADO');
    expect(situacaoOficial('A379', '8')).toBe('INCONCLUSIVO');
    // Exantemáticas: 1 sarampo e 2 rubéola confirmam, 3 descarta.
    expect(['1', '2', '3', '8'].map((c) => situacaoOficial('B09', c))).toEqual(['CONFIRMADO', 'CONFIRMADO', 'DESCARTADO', 'INCONCLUSIVO']);
    expect(situacaoOficial('A959', '3')).toBe('DESCARTADO');
    expect(['1', '3', '4', '8'].map((c) => situacaoOficial('B19', c))).toEqual(['CONFIRMADO', 'DESCARTADO', 'DESCARTADO', 'INCONCLUSIVO']);
    expect(['1', '2', '3', '4'].map((c) => situacaoOficial('J11', c))).toEqual(['CONFIRMADO', 'DESCARTADO', 'DESCARTADO', 'INCONCLUSIVO']);
    expect(['2', '4', '6'].map((c) => situacaoOficial('A809', c))).toEqual(['CONFIRMADO', 'DESCARTADO', 'INCONCLUSIVO']);
    expect(['3', '4'].map((c) => situacaoOficial('P350', c))).toEqual(['DESCARTADO', 'INCONCLUSIVO']);
    // Intoxicação exógena: 4 (outro diagnóstico) conta como descartado e 9 (ignorado) como inconclusivo.
    expect(['1', '2', '4', '9'].map((c) => situacaoOficial('T659', c))).toEqual(['CONFIRMADO', 'CONFIRMADO', 'DESCARTADO', 'INCONCLUSIVO']);
    // Sífilis: sem descarte (classificação atribuída pelo sistema).
    expect(situacaoOficial('O981', '1')).toBe('CONFIRMADO');
    expect(AGRAVOS_SINAN.A509!.descartado).toEqual([]);
    // Agravo sem tabela: regra padrão.
    expect(situacaoOficial('Z999', '2')).toBe('DESCARTADO');
    expect(situacaoOficial(null, '1')).toBe('CONFIRMADO');
  });

  it('gravidade só onde a classificação a traz', () => {
    expect(gravidadeOficial('A90', '11')).toBe('SINAIS_ALARME');
    expect(gravidadeOficial('A90', '12')).toBe('GRAVE');
    expect(gravidadeOficial('A90', '10')).toBeNull();
    expect(gravidadeOficial('A920', '12')).toBeNull();
    expect(gravidadeOficial('X29', '3')).toBe('GRAVE');
    expect(gravidadeOficial(null, '12')).toBeNull();
    // Óbitos: pelo agravo e em investigação.
    expect(AGRAVOS_SINAN.A90).toMatchObject({ obitoAgravo: ['2'], obitoInvestigacao: ['4'] });
    expect(AGRAVOS_SINAN.A169!.obitoAgravo).toEqual(['3']);
  });

  it('situação da notificação do OmniSaúde', () => {
    expect(situacaoOmni({ status: 'NOTIFICADA', finalClass: null })).toBe('EM_INVESTIGACAO');
    expect(situacaoOmni({ status: 'ENCERRADA', finalClass: '1' })).toBe('CONFIRMADO');
    expect(situacaoOmni({ status: 'ENCERRADA', finalClass: '2' })).toBe('DESCARTADO');
    expect(situacaoOmni({ status: 'ENCERRADA', finalClass: '8' })).toBe('INCONCLUSIVO');
    expect(situacaoOmni({ status: 'DESCARTADA', finalClass: null })).toBe('DESCARTADO');
  });
});

describe('correções do §1 vindas da pesquisa', () => {
  it('sarampo e rubéola são o mesmo agravo no Sinan Net (B09, sem variante)', () => {
    expect(agravoSinanDaChave('sarampo-rubeola', 'B05')).toBe('sarampo-rubeola');
    expect(agravoSinanDaChave('sarampo-rubeola', 'B06.9')).toBe('sarampo-rubeola');
    expect(agravoSinanDaChave('sarampo-rubeola', null)).toBe('sarampo-rubeola');
    expect(mesmoAgravoSinan(agravoSinanDaChave('sarampo-rubeola', 'B05'), agravoSinanDaChave('sarampo-rubeola', 'B06'))).toBe(true);
    expect(agravoSinanDaChave('meningites', 'A39')).toBe('meningites');
  });

  it('prazo de encerramento: leishmaniose visceral em 60 dias (errata); hepatites e LTA em 180', () => {
    const dias = (g: string) => PRAZOS_ENCERRAMENTO_REFERENCIA.find((p) => p.grupos.includes(g))?.dias;
    expect(dias('leishmaniose-visceral')).toBe(60);
    expect(dias('hepatites-virais')).toBe(180);
    expect(dias('lta')).toBe(180);
    expect(PRAZOS_ENCERRAMENTO_REFERENCIA.find((p) => p.grupos.includes('leishmaniose-visceral'))!.fonte).toContain('Errata');
  });

  it('e-SUS Notifica: formato documentado na dica, validação larga', () => {
    expect(SISTEMA_INFO.ESUS_NOTIFICA.numero.dica).toContain('12 dígitos');
    expect(SISTEMA_INFO.ESUS_NOTIFICA.numero.dica).toContain('14 dígitos');
    expect(numeroOficialValido('ESUS_NOTIFICA', '351234567890')).toBe(true);
    // O sequencial passa dos "00" do modelo UFAA00NNNNNN: não são fixos.
    expect(numeroOficialValido('ESUS_NOTIFICA', '352114314809')).toBe(true);
    expect(numeroOficialValido('ESUS_NOTIFICA', '35202612345678')).toBe(true);
    expect(numeroOficialValido('ESUS_NOTIFICA', '1234567')).toBe(false);
  });
});
