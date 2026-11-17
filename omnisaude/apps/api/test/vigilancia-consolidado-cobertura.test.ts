import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, semanaDaData, semanaEpidemiologica } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { ConsolidadoService } from '../src/modules/vigilancia/consolidado.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Cobertura da base consolidada por SE, terceira rodada da semana 27 (VIG-1c): o "OmniSaúde em uso desde" sai de
 * quando a primeira ficha entrou no sistema, não da data de conhecimento (DIAGRAMA-4); o período do arquivo termina na
 * data do envio (conciliacao-3, a mesma regra do "só no OmniSaúde"); o arquivo de um CNES só não cobre a SE, mas os
 * registros dele contam (imp-cobertura-so-omni). Dados sintéticos.
 */
const enabled = await pgAvailable();
const FUSO = 'America/Sao_Paulo';
const MUNICIPIO = demoFixtures.DEMO_TENANT.ibgeCode;

describe.runIf(enabled)('Vigilância: cobertura da base consolidada (terceira rodada)', () => {
  let t: TestApp;
  let recepcao = '';
  let medica = '';
  let autor = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let sys: { tenant: Awaited<ReturnType<TenantsService['resolve']>>; db: typeof db };
  let n = 0;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const casos = (grupo: string, anos: number[]) => t.app.get(ConsolidadoService).casosPorSemana(sys, { grupo, nivel: 'MUNICIPIO', territorioId: null, anos, base: 'PROVAVEIS' });
  /** Importação aplicada com um arquivo, montada direto no banco (o envio com data e o CNES que a importação grava). */
  const importacao = async (o: { sistema: 'SINAN_NET' | 'ESUS_NOTIFICA'; arquivo: Record<string, unknown>; declarado?: [string, string]; enviadaEm: Date }) =>
    (
      await db.officialImport.create({
        data: {
          system: o.sistema,
          status: 'APLICADA',
          fileName: String(o.arquivo.nome),
          sha256: String(++n).padStart(64, 'f'),
          sizeBytes: 1,
          files: [{ tipoRegistro: 'INDIVIDUAL', tamanhoBytes: 1, registros: 1, codificacao: null, origemCodificacao: null, agravos: [], identificado: false, ignorado: false, avisos: [], ...o.arquivo }],
          periodFrom: o.declarado ? new Date(`${o.declarado[0]}T00:00:00Z`) : null,
          periodTo: o.declarado ? new Date(`${o.declarado[1]}T00:00:00Z`) : null,
          declaredPeriod: !!o.declarado,
          createdBy: autor,
          createdAt: o.enviadaEm,
          appliedBy: autor,
          appliedAt: o.enviadaEm,
        },
      })
    ).id;

  beforeAll(async () => {
    t = await startTestApp('vigconsolcob');
    t.app.get(AiService).client = null;
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    sys = { tenant, db };
    autor = (await db.user.findFirstOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf }, select: { id: true } })).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('DIAGRAMA-4: a ficha digitada hoje com conhecimento em 2013 não cobre com zeros 2013 e 2014 de todo agravo', async () => {
    const antes = await casos('coqueluche', [2013, 2014]);
    expect(antes.cobertura.map((c) => c.motivo)).toEqual(['Nenhuma base cobre o ano: fica fora do canal', 'Nenhuma base cobre o ano: fica fora do canal']);
    const body = {
      name: 'Paciente Retroativo Cobertura',
      birthDate: '1975-05-05',
      sex: 'M',
      cpf: completeCpf('276000901'),
      cns: cnsFromBase('27600000901'),
      motherName: 'Mae Retroativo Cobertura',
      phone: '(11) 97777-2704',
      address: { cep: '01001000', street: 'Rua do Retroativo', number: '27', district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
      confirmNotDuplicate: true,
    };
    const patientId = (await t.http().post('/api/patients').set(auth(recepcao)).send(body).expect(201)).body.id as string;
    // Papel atrasado ou carga retroativa: conhecida em 10/03/2013, entra no sistema agora.
    const criada = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId, conditionKey: 'leptospirose', knownAt: '2013-03-10T15:00:00.000Z' }).expect(201)).body as { id: string };
    expect((await t.http().post(`/api/vigilancia/notificacoes/${criada.id}/confirmar`).set(auth(medica)).expect(200)).body.status).toBe('NOTIFICADA');

    const depois = await casos('coqueluche', [2013, 2014]);
    expect(depois.cobertura.map((c) => c.motivo)).toEqual(['Nenhuma base cobre o ano: fica fora do canal', 'Nenhuma base cobre o ano: fica fora do canal']);
    expect([...depois.porAno.get(2014)!].every((v) => v === null)).toBe(true);
    // O OmniSaúde passa a cobrir da SE em que a ficha entrou no sistema (hoje) em diante.
    const se = semanaEpidemiologica(new Date(), FUSO);
    const atual = await casos('coqueluche', [se.ano]);
    expect(atual.porAno.get(se.ano)![se.semana - 1]).toBe(0);
    if (se.semana > 1) expect(atual.porAno.get(se.ano)![se.semana - 2]).toBeNull();
    expect(atual.cobertura[0]!.motivo).toContain(se.semana > 1 ? `OmniSaúde em uso desde a SE ${String(se.semana).padStart(2, '0')}/${se.ano}` : 'OmniSaúde em uso');
  });

  it('conciliacao-3: o período declarado do arquivo vai só até a data do envio (o ano inteiro declarado em junho cobre até junho)', async () => {
    await importacao({
      sistema: 'SINAN_NET',
      arquivo: { nome: 'ZIKANET2015.DBF', tipo: 'AGRAVO_NET', sistema: 'SINAN_NET', agravos: ['A928'], periodo: { de: '2015-01-05', ate: '2015-06-12' } },
      declarado: ['2015-01-01', '2015-12-31'],
      enviadaEm: new Date('2015-06-15T15:00:00Z'),
    });
    const r = await casos('zika', [2015]);
    const se = semanaDaData('2015-06-15').semana;
    const serie = r.porAno.get(2015)!;
    expect(serie.slice(0, se).every((v) => v === 0)).toBe(true);
    expect(serie.slice(se).every((v) => v === null)).toBe(true);
    expect(r.cobertura).toEqual([{ ano: 2015, coberto: true, parcial: true, semanasCobertas: se, motivo: `Coberto só nas SE 1 a ${se} (importação aplicada: ZIKANET2015.DBF); as demais SE ficam fora do canal` }]);
  });

  it('imp-cobertura-so-omni: o arquivo do e-SUS de um CNES só não cobre a SE do município; os registros dele contam', async () => {
    const soUpa = await importacao({
      sistema: 'ESUS_NOTIFICA',
      arquivo: { nome: 'esus-upa-2016.csv', tipo: 'ESUS_NOTIFICA_CSV', sistema: 'ESUS_NOTIFICA', grupos: ['covid'], periodo: { de: '2016-03-01', ate: '2016-03-31' }, cnes: '9000036' },
      enviadaEm: new Date('2016-04-01T15:00:00Z'),
    });
    await db.officialRecord.create({
      data: {
        system: 'ESUS_NOTIFICA',
        type: 'INDIVIDUAL',
        naturalKey: 'cob-cnes-1',
        number: '351600000001',
        notifiedOn: new Date('2016-03-08T00:00:00Z'),
        epiWeekNotified: '201610',
        epiWeekOnset: '201610',
        municipalityIbge: MUNICIPIO,
        residenceIbge: MUNICIPIO,
        unitCnes: '9000036',
        groupKey: 'covid',
        situation: 'CONFIRMADO',
        contentHash: '0'.repeat(64),
        firstImportId: soUpa,
        lastImportId: soUpa,
        lastSeenAt: new Date('2016-04-01T15:00:00Z'),
      },
    });
    // Um arquivo de todas as unidades (sem o CNES) de maio cobre as SE dele.
    await importacao({
      sistema: 'ESUS_NOTIFICA',
      arquivo: { nome: 'esus-todas-2016.csv', tipo: 'ESUS_NOTIFICA_CSV', sistema: 'ESUS_NOTIFICA', grupos: ['covid'], periodo: { de: '2016-05-01', ate: '2016-05-31' }, cnes: null },
      enviadaEm: new Date('2016-06-01T15:00:00Z'),
    });
    const serie = (await casos('covid', [2016])).porAno.get(2016)!;
    // SE 9 a 13 (março): só a SE 10, do caso, fica coberta; o resto de março fica fora do canal.
    expect(serie.slice(8, 13)).toEqual([null, 1, null, null, null]);
    // Maio (SE 18 a 22): coberto pelo arquivo de todas as unidades, sem caso.
    expect(serie.slice(17, 22)).toEqual([0, 0, 0, 0, 0]);
  });
});
