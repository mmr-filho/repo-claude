import { describe, expect, it } from 'vitest';
import {
  agravoSinanDaChave,
  mesmoAgravoSinan,
  exigeComunicacaoPolicial,
  numeroOficialValido,
  orientacaoViolencia,
  validarEncerramento,
  calcularPrazo,
  escolherCondicao,
  esferasImediatas,
  idadeSinan,
  intervaloDaSemana,
  LNNC_NACIONAL,
  MAPEAMENTOS_INICIAIS,
  mapearCodigo,
  mesclarCatalogo,
  normalizarCodigo,
  prazoRepasse,
  semanaDaData,
  semanaEpidemiologica,
  semanasNoAno,
  situacaoDoPrazo,
  versaoNaData,
} from '../src/vigilancia';

const v11211 = LNNC_NACIONAL.find((v) => v.id === 'PRT-GM-MS-11211-2026')!;
const v10175 = LNNC_NACIONAL.find((v) => v.id === 'PRT-GM-MS-10175-2026')!;
const linha = (v: typeof v11211, item: number, sub: string | null = null) => v.conditions.find((c) => c.item === item && c.subitem === sub)!;
const marcas = (c: ReturnType<typeof linha>) => ({ MS: c.immediateMs, SES: c.immediateSes, SMS: c.immediateSms, SEM: c.weekly });

describe('Semana epidemiológica (calendário do Sinan)', () => {
  it('confere com os calendários oficiais de 2025 e 2026', () => {
    expect(semanaDaData('2024-12-29').codigo).toBe('202501');
    expect(semanaDaData('2025-01-04').codigo).toBe('202501');
    expect(semanaDaData('2026-01-03').codigo).toBe('202553');
    expect(semanaDaData('2026-01-04').codigo).toBe('202601');
    expect(semanaDaData('2026-01-10').codigo).toBe('202601');
    expect(semanaDaData('2026-10-31').codigo).toBe('202643');
    expect(semanaDaData('2026-11-01').codigo).toBe('202644');
    expect(semanaDaData('2027-01-02').codigo).toBe('202652');
    expect(semanaDaData('2027-01-03').codigo).toBe('202701');
    expect(semanasNoAno(2025)).toBe(53);
    expect(semanasNoAno(2026)).toBe(52);
    expect(intervaloDaSemana(2026, 44)).toEqual({ inicio: '2026-11-01', fim: '2026-11-07' });
  });

  it('lê a data no fuso da instituição', () => {
    // 01/11/2026 02:00 UTC ainda é sábado, 31/10, em São Paulo.
    expect(semanaEpidemiologica(new Date('2026-11-01T02:00:00Z'), 'America/Sao_Paulo').codigo).toBe('202643');
    expect(semanaEpidemiologica(new Date('2026-11-01T02:00:00Z'), 'UTC').codigo).toBe('202644');
  });
});

describe('Catálogo da Lista Nacional (gerado do compilado da BVS)', () => {
  it('reproduz as linhas e itens das duas redações', () => {
    expect(v11211.conditions).toHaveLength(81);
    expect(new Set(v11211.conditions.map((c) => c.item)).size).toBe(66);
    expect(v10175.conditions).toHaveLength(77);
    expect(new Set(v10175.conditions.map((c) => c.item)).size).toBe(66);
    expect(v11211.validFrom).toBe('2026-05-14');
    expect(v10175.validTo).toBe('2026-05-13');
    expect(v11211.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marcas conferidas célula a célula na redação da PRT 11.211/2026', () => {
    expect(marcas(linha(v11211, 1, 'a'))).toEqual({ MS: false, SES: false, SMS: false, SEM: true });
    expect(marcas(linha(v11211, 1, 'b'))).toEqual({ MS: false, SES: false, SMS: true, SEM: false });
    expect(marcas(linha(v11211, 8))).toEqual({ MS: false, SES: true, SMS: true, SEM: false });
    expect(marcas(linha(v11211, 9, 'b'))).toEqual({ MS: true, SES: true, SMS: true, SEM: false });
    expect(marcas(linha(v11211, 11))).toEqual({ MS: true, SES: true, SMS: true, SEM: false });
    expect(marcas(linha(v11211, 13, 'a'))).toEqual({ MS: false, SES: true, SMS: true, SEM: false });
    expect(linha(v11211, 13, 'b').weekly).toBe(true);
    expect(linha(v11211, 19, 'd').weekly).toBe(true);
    expect(marcas(linha(v11211, 61, 'a'))).toEqual({ MS: false, SES: true, SMS: true, SEM: false });
    expect(marcas(linha(v11211, 61, 'b'))).toEqual({ MS: true, SES: true, SMS: true, SEM: false });
    expect(marcas(linha(v11211, 65))).toEqual({ MS: false, SES: true, SMS: true, SEM: false });
    expect(marcas(linha(v11211, 66, 'b'))).toEqual({ MS: false, SES: false, SMS: true, SEM: false });
    // Caxumba: semanal no Anexo, com o selo de revisão normativa.
    expect(linha(v11211, 48)).toMatchObject({ key: 'caxumba', weekly: true, normativeStatus: 'EM_REVISAO' });
    expect(linha(v11211, 60)).toMatchObject({ key: 'sg-covid-confirmada', notifyOn: 'CONFIRMACAO', deadlineStart: 'CONFIRMACAO' });
    // Difteria: só SES e SMS na redação anterior.
    expect(marcas(v10175.conditions.find((c) => c.key === 'difteria')!)).toEqual({ MS: false, SES: true, SMS: true, SEM: false });
  });

  it('toda linha tem uma única periodicidade e chaves únicas; sigilo nos agravos sensíveis', () => {
    for (const v of LNNC_NACIONAL) {
      for (const c of v.conditions) expect(c.weekly).toBe(!(c.immediateMs || c.immediateSes || c.immediateSms));
      expect(new Set(v.conditions.map((c) => c.key)).size).toBe(v.conditions.length);
    }
    const sensiveis = v11211.conditions.filter((c) => c.sensitive).map((c) => `${c.item}${c.subitem ?? ''}`);
    expect(sensiveis.sort()).toEqual(['34', '35', '36', '56', '66a', '66b'].sort());
  });

  it('todo grupo do de-para existe no catálogo', () => {
    const grupos = new Set(LNNC_NACIONAL.flatMap((v) => v.conditions.map((c) => c.group)));
    const faltando = [...new Set(MAPEAMENTOS_INICIAIS.map((m) => m.group))].filter((g) => !grupos.has(g));
    expect(faltando).toEqual([]);
    expect(MAPEAMENTOS_INICIAIS.filter((m) => m.status === 'HOMOLOGADO').map((m) => m.codePrefix)).toEqual(['A379', 'A930', 'B42', 'W64']);
  });
});

describe('Regras de notificação', () => {
  it('versão vigente na data e sobreposição local', () => {
    expect(versaoNaData(LNNC_NACIONAL, '2026-05-10')!.versao.id).toBe('PRT-GM-MS-10175-2026');
    expect(versaoNaData(LNNC_NACIONAL, '2026-05-15')!.versao.id).toBe('PRT-GM-MS-11211-2026');
    expect(versaoNaData(LNNC_NACIONAL, '2025-12-01')).toMatchObject({ anteriorAoCatalogo: true });
    expect(v10175.conditions.some((c) => c.key === 'sg-covid-confirmada')).toBe(false);
    const caxumbaMunicipal = { ...linha(v11211, 48), weekly: false, immediateSms: true };
    const retrato = mesclarCatalogo(v11211.conditions, [], [caxumbaMunicipal]);
    expect(retrato.find((c) => c.key === 'caxumba')).toMatchObject({ weekly: false, immediateSms: true });
    expect(retrato).toHaveLength(81);
  });

  it('subitem pelo contexto', () => {
    const cat = v11211.conditions;
    expect(escolherCondicao(cat, 'dengue', {})!.key).toBe('dengue');
    expect(escolherCondicao(cat, 'dengue', { obito: true })!.key).toBe('dengue-obito');
    expect(escolherCondicao(cat, 'oropouche', { gestante: true })!.key).toBe('oropouche-gestante');
    expect(escolherCondicao(cat, 'oropouche', {})!.key).toBe('oropouche');
    expect(escolherCondicao(cat, 'zika', { dica: 'ANOMALIA_CONGENITA' })!.key).toBe('zika-congenita');
    expect(escolherCondicao(cat, 'malaria', { amazoniaLegal: true })!.key).toBe('malaria');
    expect(escolherCondicao(cat, 'malaria', { amazoniaLegal: false })!.key).toBe('malaria-extra-amazonica');
    expect(escolherCondicao(cat, 'inexistente', {})).toBeNull();
  });

  it('prazos de 24 h e de 7 dias, repasse e situação', () => {
    const atend = new Date('2027-04-06T10:00:00Z');
    const assin = new Date('2027-04-06T10:30:00Z');
    const coq = calcularPrazo(linha(v11211, 8), { atendimento: atend, conhecimento: assin, confirmacao: null });
    expect(coq).toMatchObject({ tipo: 'IMEDIATA', esferas: ['SMS', 'SES'], marco: 'ATENDIMENTO' });
    expect(coq.vence!.toISOString()).toBe('2027-04-07T10:00:00.000Z');
    const dengue = calcularPrazo(linha(v11211, 9, 'a'), { atendimento: atend, conhecimento: assin, confirmacao: null });
    expect(dengue).toMatchObject({ tipo: 'SEMANAL', esferas: ['SMS'], marco: 'CONHECIMENTO' });
    expect(dengue.vence!.toISOString()).toBe('2027-04-13T10:30:00.000Z');
    const internado = calcularPrazo(linha(v11211, 8), { atendimento: atend, conhecimento: new Date('2027-04-09T08:00:00Z'), confirmacao: null, internacao: true });
    expect(internado.marco).toBe('CONHECIMENTO');
    expect(internado.vence!.toISOString()).toBe('2027-04-10T08:00:00.000Z');
    const covid = calcularPrazo(linha(v11211, 60), { atendimento: atend, conhecimento: assin, confirmacao: null });
    expect(covid).toMatchObject({ aguardandoConfirmacao: true, vence: null });
    expect(calcularPrazo(linha(v11211, 60), { atendimento: atend, conhecimento: assin, confirmacao: new Date('2027-04-08T12:00:00Z') }).vence!.toISOString()).toBe('2027-04-09T12:00:00.000Z');
    expect(prazoRepasse(new Date('2027-04-06T12:00:00Z')).toISOString()).toBe('2027-04-07T12:00:00.000Z');
    expect(esferasImediatas(linha(v11211, 9, 'b'))).toEqual(['SMS', 'SES', 'MS']);
    const vence = new Date('2027-04-07T10:00:00Z');
    expect(situacaoDoPrazo(vence, null, new Date('2027-04-06T12:00:00Z'))).toBe('NO_PRAZO');
    expect(situacaoDoPrazo(vence, null, new Date('2027-04-07T06:00:00Z'))).toBe('A_VENCER');
    expect(situacaoDoPrazo(vence, null, new Date('2027-04-07T10:01:00Z'))).toBe('VENCIDO');
    expect(situacaoDoPrazo(vence, new Date(), new Date('2027-04-08T00:00:00Z'))).toBe('CUMPRIDO');
  });

  it('códigos, prefixo mais longo e idade do Sinan', () => {
    expect(normalizarCodigo('CID10:A37.9')).toEqual({ system: 'CID10', code: 'A379' });
    expect(normalizarCodigo('I10')).toEqual({ system: 'CID10', code: 'I10' });
    expect(normalizarCodigo('CIAP2:A70')).toEqual({ system: 'CIAP2', code: 'A70' });
    expect(mapearCodigo(MAPEAMENTOS_INICIAIS, 'CID10', 'A379').map((m) => m.status)).toEqual(['HOMOLOGADO']);
    expect(mapearCodigo(MAPEAMENTOS_INICIAIS, 'CID10', 'A371').map((m) => m.status)).toEqual(['PROPOSTO']);
    expect(mapearCodigo(MAPEAMENTOS_INICIAIS, 'CID10', 'G000').map((m) => m.group)).toEqual(['haemophilus-invasiva']);
    expect(mapearCodigo(MAPEAMENTOS_INICIAIS, 'CID10', 'G001').map((m) => m.group)).toEqual(['meningites']);
    expect(mapearCodigo(MAPEAMENTOS_INICIAIS, 'CID10', 'I10')).toEqual([]);
    const nasc = new Date('2026-04-06T08:00:00Z');
    expect(idadeSinan(nasc, new Date('2026-04-06T20:00:00Z'))).toMatchObject({ unidade: 'H', valor: 12, codigo: '1012' });
    expect(idadeSinan(nasc, new Date('2026-04-20T08:00:00Z'))).toMatchObject({ unidade: 'D', valor: 14 });
    expect(idadeSinan(nasc, new Date('2026-09-10T08:00:00Z'))).toMatchObject({ unidade: 'M', valor: 5, codigo: '3005' });
    expect(idadeSinan(new Date('1980-05-20T12:00:00Z'), new Date('2027-04-06T12:00:00Z'))).toMatchObject({ unidade: 'A', valor: 46, codigo: '4046' });
  });

  it('chave do Sinan Net: violências num agravo, sífilis, tétano e toxoplasmose separados, sarampo/rubéola num agravo só', () => {
    expect(agravoSinanDaChave('violencia', 'T741')).toBe(agravoSinanDaChave('violencia-sexual-suicidio', 'X64'));
    expect(agravoSinanDaChave('sifilis', 'A539')).toBe('sifilis:adquirida');
    expect(agravoSinanDaChave('sifilis', 'A539', true)).toBe('sifilis:gestante');
    expect(agravoSinanDaChave('sifilis', 'O98.1')).toBe('sifilis:gestante');
    expect(agravoSinanDaChave('sifilis', 'A50.9')).toBe('sifilis:congenita');
    expect(agravoSinanDaChave('tetano', 'A33')).not.toBe(agravoSinanDaChave('tetano', 'A35'));
    expect(agravoSinanDaChave('tetano', null, false, 'tetano-neonatal')).toBe(agravoSinanDaChave('tetano', 'A33'));
    expect(agravoSinanDaChave('toxoplasmose-gestacional-congenita', 'O98.6')).not.toBe(agravoSinanDaChave('toxoplasmose-gestacional-congenita', 'P37.1'));
    // Sarampo e rubéola são o mesmo agravo no Sinan Net (B09; o CS_SUSPEIT não é campo-chave), como as meningites (G03.9).
    expect(agravoSinanDaChave('sarampo-rubeola', 'B05')).toBe('sarampo-rubeola');
    expect(agravoSinanDaChave('sarampo-rubeola', 'B06')).toBe('sarampo-rubeola');
    expect(mesmoAgravoSinan(agravoSinanDaChave('sarampo-rubeola', 'B05'), agravoSinanDaChave('sarampo-rubeola', 'B06'))).toBe(true);
    expect(agravoSinanDaChave('meningites', 'A39')).toBe(agravoSinanDaChave('meningites', 'G03'));
    // Notificação manual sem CID: a variante é desconhecida e casa com qualquer uma do grupo.
    expect(mesmoAgravoSinan(agravoSinanDaChave('tetano', null), agravoSinanDaChave('tetano', 'A33'))).toBe(true);
    expect(mesmoAgravoSinan(agravoSinanDaChave('tetano', null), agravoSinanDaChave('dengue', 'A90'))).toBe(false);
    expect(agravoSinanDaChave('dengue', 'A90')).toBe('dengue');
  });

  it('números oficiais, violência por idade e data do óbito no encerramento', () => {
    expect(numeroOficialValido('SINAN_NET', '417')).toBe(true);
    expect(numeroOficialValido('SINAN_NET', '12345678')).toBe(false);
    expect(numeroOficialValido('ESUS_SINAN', '172600000123')).toBe(true);
    expect(numeroOficialValido('ESUS_SINAN', '1726000123')).toBe(false);
    expect(numeroOficialValido('SIVEP_GRIPE', '315638864347')).toBe(true);
    expect(numeroOficialValido('SIVEP_GRIPE', '3156388643471')).toBe(false);
    expect(numeroOficialValido('SIVEP_GRIPE', '31778250106779')).toBe(true);
    const v = { groupKey: 'violencia', code: 'T741' };
    expect(exigeComunicacaoPolicial(v, 'F', 30)).toBe(true);
    expect(exigeComunicacaoPolicial(v, 'F', 17)).toBe(false);
    expect(exigeComunicacaoPolicial(v, 'F', 60)).toBe(false);
    expect(exigeComunicacaoPolicial({ groupKey: 'violencia-sexual-suicidio', code: 'X64' }, 'F', 30)).toBe(false);
    expect(orientacaoViolencia(v, 12)).toContain('Conselho Tutelar');
    expect(orientacaoViolencia(v, 70)).toContain('Estatuto da Pessoa Idosa');
    const base = { investigadaEm: '2026-10-10', classificacao: '2', criterio: '1', evolucao: '1', obitoEm: '2026-10-11', encerradaEm: '2026-10-12' };
    expect(validarEncerramento(base, { notificadaEm: '2026-10-01', sintomas: null, hoje: '2026-11-01' }).join(' ')).toContain('campo 42');
    expect(validarEncerramento({ ...base, obitoEm: null }, { notificadaEm: '2026-10-01', sintomas: null, hoje: '2026-11-01' })).toEqual([]);
  });
});
