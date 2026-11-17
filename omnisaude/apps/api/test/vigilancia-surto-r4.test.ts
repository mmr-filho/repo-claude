import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString } from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Surto (VIG-1c), quarta rodada da semana 27. O registro oficial conciliado com a notificação
 * (official_records.notification_id) é o mesmo caso dela: a notificação cujo registro está numa planilha sai das
 * sugestões e do evento inusitado, e "Notificar surto" e a inclusão avisam o outro surto aberto pelas três origens (sur-4,
 * N11 e SURTO-5). O caso que ficou em duas linhas da planilha (vínculo feito depois) é avisado no detalhe e no espelho e
 * conta uma vez (SURTO-5 e N6). A inclusão segura só a trava do surto, nunca a da conciliação. A epidemia de um agravo
 * que as regras de vizinhança alcançam não tira o evento inusitado de outro (SURTO-2).
 */
const enabled = await pgAvailable();
const H = 3_600_000;
const DIA = 24 * H;
const TZ = 'America/Sao_Paulo';
const hoje = () => localDateString(new Date(), TZ);
const diasAtras = (n: number) => localDateString(new Date(Date.now() - n * DIA), TZ);
const pausa = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

type Sugestao = { assinatura: string; regra: string; grupo: string; casos: string[] };
type Caso = { id: string; numero: number; notificationId: string | null; officialRecordId: string | null; mesmoCasoQue: number | null };
type Espelho = { planilha: Record<string, string | null>[]; avisos: string[] };
type Detalhe = { id: string; numero: string; status: string; casosNaPlanilha: number; avisos: string[]; planilha: Caso[]; espelho: Espelho };

describe.runIf(enabled)('Vigilância: surto, quarta rodada (semana 27)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  const tk: Record<string, string> = {};
  const U: Record<string, { id: string; cnes: string }> = {};
  const usuario: Record<string, string> = {};
  const Q: Record<string, { id: string; centerLat: number; centerLng: number }> = {};
  let loc = '';
  let seq = 0;
  let nReg = 0;
  let importacao = '';
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const respostaSugestoes = async (k = 'vig') => (await t.http().get('/api/vigilancia/surtos/sugestoes').set(auth(k)).expect(200)).body as { sugestoes: Sugestao[]; avisos: string[] };
  const sugestoes = async (k = 'vig') => (await respostaSugestoes(k)).sugestoes;
  const inusitado = (lista: Sugestao[], grupo: string) => lista.find((s) => s.regra === 'inusitado' && s.grupo === grupo);
  const detalhe = async (id: string) => (await t.http().get(`/api/vigilancia/surtos/${id}`).set(auth('vig')).expect(200)).body as Detalhe;
  const numero = async (id: string) => (await db.notification.findUniqueOrThrow({ where: { id }, select: { number: true } })).number;
  const novoPaciente = async (nome: string) => {
    seq++;
    const body = {
      name: nome,
      birthDate: `${1960 + (seq % 40)}-0${1 + (seq % 9)}-1${seq % 8}`,
      sex: seq % 2 ? 'M' : 'F',
      cpf: completeCpf(String(274400700 + seq)),
      cns: cnsFromBase(String(27440000700 + seq)),
      motherName: `Mae de ${nome}`,
      phone: '(11) 97777-2704',
      address: { cep: '01001000', street: 'Rua da Quarta Rodada', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
      confirmNotDuplicate: true,
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  /** Bairro novo com os quarteirões pedidos (cada um num ponto próprio). */
  const bairro = async (nome: string, quarteiroes: string[]) => {
    const b = await db.neighborhood.create({ data: { localityId: loc, name: nome } });
    for (const n of quarteiroes) {
      const k = Object.keys(Q).length;
      const lat = -23.85 - k * 0.01;
      const lng = -46.95 - k * 0.01;
      const q = await db.block.create({
        data: {
          localityId: loc,
          neighborhoodId: b.id,
          number: n,
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [lng, lat],
                [lng + 0.0005, lat],
                [lng + 0.0005, lat + 0.0005],
                [lng, lat + 0.0005],
                [lng, lat],
              ],
            ],
          },
          minLng: lng,
          minLat: lat,
          maxLng: lng + 0.0005,
          maxLat: lat + 0.0005,
          centerLat: lat + 0.00025,
          centerLng: lng + 0.00025,
          areaM2: 3000,
          source: 'EDITOR',
        },
      });
      Q[n] = { id: q.id, centerLat: q.centerLat, centerLng: q.centerLng };
    }
  };
  const notificar = async (k: string, patientId: string, conditionKey: string, conhecidoHaDias: number, sintomasHaDias: number | null) =>
    (
      (
        await t
          .http()
          .post('/api/vigilancia/notificacoes')
          .set(auth(k))
          .send({ patientId, conditionKey, knownAt: new Date(Date.now() - conhecidoHaDias * DIA).toISOString(), ...(sintomasHaDias !== null ? { symptomsOnset: diasAtras(sintomasHaDias) } : {}) })
          .expect(201)
      ).body as { id: string }
    ).id;
  /** Caso de quem mora no quarteirão (domicílio ligado a ele). */
  const casoNoQuarteirao = async (nome: string, grupo: string, q: string, conhecidoHaDias: number, sintomasHaDias: number | null) => {
    const p = await novoPaciente(nome);
    const h = await db.household.create({
      data: { street: 'Rua da Quarta Rodada', number: String(seq), ibgeCode: '3550308', latitude: Q[q]!.centerLat, longitude: Q[q]!.centerLng, blockId: Q[q]!.id, families: { create: { responsibleId: p } } },
      include: { families: true },
    });
    await db.patient.update({ where: { id: p }, data: { familyId: h.families[0]!.id } });
    return notificar('medica', p, grupo, conhecidoHaDias, sintomasHaDias);
  };
  /** Registro oficial individual como a importação aplicada o deixaria, conciliado ou não com uma notificação. */
  const registro = async (o: { grupo: string; agravo: string; notificadoEm: string; nome: string; notificationId?: string }) => {
    nReg++;
    return db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: 'INDIVIDUAL',
        naturalKey: `r4sur-${nReg}`,
        number: String(8_440_000 + nReg),
        notifiedOn: new Date(`${o.notificadoEm}T00:00:00Z`),
        municipalityIbge: '355030',
        unitCnes: U.ubs!.cnes,
        unitId: U.ubs!.id,
        agravo: o.agravo,
        groupKey: o.grupo,
        residenceIbge: '355030',
        situation: 'CONFIRMADO',
        patientName: o.nome,
        sex: 'M',
        contentHash: '0'.repeat(64),
        firstImportId: importacao,
        lastImportId: importacao,
        lastSeenAt: new Date(),
        ...(o.notificationId ? { notificationId: o.notificationId, matchMethod: 'MANUAL' as const, matchedBy: usuario.vigilancia!, matchedAt: new Date() } : {}),
      },
    });
  };
  /**
   * O vínculo feito depois de as duas linhas estarem na planilha. A conciliação agora recusa o vínculo manual com o surto
   * aberto (409) e o automático pula o par, mas o dado de antes, a corrida e o surto já encerrado deixam esse estado:
   * gravado direto no banco, como a conciliação o deixaria.
   */
  const vincularNoBanco = (recordId: string, notificationId: string) =>
    db.officialRecord.update({ where: { id: recordId }, data: { notificationId, matchMethod: 'MANUAL', matchedBy: usuario.vigilancia!, matchedAt: new Date() } });
  const base = () => ({ notificadoEm: hoje(), conhecidoEm: new Date(Date.now() - H).toISOString(), primeirosSintomasEm: diasAtras(4), casos: 2, localInicial: '8' });
  const criarSurto = (corpo: Record<string, unknown>) =>
    t
      .http()
      .post('/api/vigilancia/surtos')
      .set(auth('vig'))
      .send({ ...base(), categoria: 'DA_LISTA', unitId: U.ubs!.id, ...corpo });
  const incluir = (id: string, corpo: Record<string, unknown>) => t.http().post(`/api/vigilancia/surtos/${id}/casos`).set(auth('vig')).send(corpo);
  /**
   * Cópias da notificação (mesmo paciente e agravo), conhecidas ao acaso nas últimas `janelaMs`, por SQL, com o número
   * começando por `prefixo` (para apagar depois). A numeração segue o maior `seq` do banco.
   */
  const copiar = async (molde: string, n: number, janelaMs: number, prefixo: string) => {
    const inicio = (await db.$queryRawUnsafe<{ inicio: number }[]>(`SELECT COALESCE(max(seq), 0)::int AS inicio FROM notifications`))[0]!.inicio;
    await db.$executeRawUnsafe(
      `INSERT INTO notifications (id, year, seq, number, status, origin, condition_id, condition_key, group_key, basis, code_system, code, map_status, patient_id, unit_id, notifier_id, notifier_cbo, notifier_role, first_care_at, known_at, confirmed_at, deadline_start, deadline_kind, targets, deadline_start_at, due_at, notified_at, symptoms_onset, epi_week_notified, epi_week_onset, sensitive, form, residence_ibge, residence_lat, residence_lng, out_of_municipality, created_by, created_at, updated_at, residence_precision)
       SELECT gen_random_uuid(), year, ${inicio} + g, '${prefixo}' || (${inicio} + g), status, origin, condition_id, condition_key, group_key, basis, code_system, code, map_status, patient_id, unit_id, notifier_id, notifier_cbo, notifier_role, first_care_at,
              now() AT TIME ZONE 'UTC' - (random() * ${janelaMs} || ' milliseconds')::interval, confirmed_at, deadline_start, deadline_kind, targets, deadline_start_at, due_at, notified_at, symptoms_onset, epi_week_notified, epi_week_onset, sensitive, '{}'::jsonb, residence_ibge,
              residence_lat, residence_lng, out_of_municipality, created_by, created_at, updated_at, residence_precision
       FROM notifications, generate_series(1, ${n}) g WHERE id = '${molde}'::uuid`,
    );
  };

  beforeAll(async () => {
    t = await startTestApp('vigsurtor4');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.medicaHosp = await t.login('medica', 'Hospital Municipal São Lucas', 'MEDICO');
    tk.nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    for (const u of demoFixtures.UNITS) U[u.key] = { id: (await db.unit.findUniqueOrThrow({ where: { cnes: u.cnes } })).id, cnes: u.cnes };
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
    for (const tabela of ['outbreak_cases', 'outbreak_events', 'outbreak_dismissals', 'outbreaks']) await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
    loc = (await db.locality.create({ data: { code: '972', name: 'Localidade Quarta Rodada', category: 'CIDADE', zone: 'URBANA', source: 'MANUAL' } })).id;
    await bairro('Bairro R4 S', ['S1', 'S2']);
    importacao = (await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'r4sur.zip', sha256: 'a'.repeat(64), sizeBytes: 1, createdBy: usuario.vigilancia! } })).id;
    // Histórico anterior à janela (sem ele, o evento inusitado não é avaliado).
    const antigo = await notificar('medica', await novoPaciente('Otavio Historico Quarta'), 'coqueluche', 0, null);
    await db.notification.update({ where: { id: antigo }, data: { knownAt: new Date(Date.now() - 60 * DIA) } });
  }, 180_000);

  afterAll(async () => {
    await t?.close();
  });

  it('sur-4: a notificação cujo registro conciliado está no surto (montado pela lista do Sinan) não volta como evento inusitado', async () => {
    // Febre tifoide: t1 é evento inusitado; o surto é montado pelo registro do Sinan conciliado com ela.
    const t1 = await notificar('medica', await novoPaciente('Tiago Tifoide Quarta'), 'febre-tifoide', 3, 4);
    expect(inusitado(await sugestoes(), 'febre-tifoide')?.casos).toEqual([t1]);
    const r1 = await registro({ grupo: 'febre-tifoide', agravo: 'A010', notificadoEm: diasAtras(3), nome: 'TIAGO TIFOIDE QUARTA', notificationId: t1 });
    await criarSurto({ casosIndicados: [{ officialRecordId: r1.id }], grupo: 'febre-tifoide', casos: 1, localInicial: '1' }).expect(201);
    // Antes: "Primeiro caso do agravo registrado no município" continuava com [t1].
    expect(inusitado(await sugestoes(), 'febre-tifoide')).toBeUndefined();
  });

  it('N11: as notificações cujos registros conciliados estão no surto saem do quarteirão, do bairro e do evento inusitado', async () => {
    // Hantavirose: n1 e n2 no mesmo quarteirão; o surto H é montado pelos registros ra e rb, conciliados com elas.
    const n1 = await casoNoQuarteirao('Hugo Hanta Um Quarta', 'hantavirose', 'S1', 3, 4);
    const n2 = await casoNoQuarteirao('Hilda Hanta Dois Quarta', 'hantavirose', 'S1', 2, 3);
    const q = `quarteirao-7d|QUARTEIRAO:${Q.S1!.id}|hantavirose`;
    const antes = await sugestoes();
    expect([...antes.find((s) => s.assinatura === q)!.casos].sort()).toEqual([n1, n2].sort());
    expect(
      antes
        .filter((s) => s.casos.includes(n1))
        .map((s) => s.regra)
        .sort(),
    ).toEqual(['bairro-7d', 'inusitado', 'quarteirao-7d']);
    const ra = await registro({ grupo: 'hantavirose', agravo: 'A985', notificadoEm: diasAtras(3), nome: 'HUGO HANTA UM QUARTA', notificationId: n1 });
    const rb = await registro({ grupo: 'hantavirose', agravo: 'A985', notificadoEm: diasAtras(2), nome: 'HILDA HANTA DOIS QUARTA', notificationId: n2 });
    await criarSurto({ casosIndicados: [{ officialRecordId: ra.id }, { officialRecordId: rb.id }], grupo: 'hantavirose' }).expect(201);
    // Antes: o quarteirão, o bairro e o evento inusitado de hantavirose continuavam com [n1, n2].
    expect((await sugestoes()).filter((s) => s.casos.some((c) => [n1, n2].includes(c)))).toEqual([]);
  });

  it('N11: "Notificar surto" pela sugestão que a tela ainda mostrava avisa que os casos já estão no surto, pelos registros conciliados', async () => {
    // Hepatites virais: e1 e e2 no mesmo quarteirão; a tela carregou a sugestão antes de o surto E ser montado pelos
    // registros do Sinan conciliados com elas.
    const e1 = await casoNoQuarteirao('Elias Hepatite Um Quarta', 'hepatites-virais', 'S2', 3, 4);
    const e2 = await casoNoQuarteirao('Eloa Hepatite Dois Quarta', 'hepatites-virais', 'S2', 2, 3);
    const q = `quarteirao-7d|QUARTEIRAO:${Q.S2!.id}|hepatites-virais`;
    expect([...(await sugestoes()).find((s) => s.assinatura === q)!.casos].sort()).toEqual([e1, e2].sort());
    const re1 = await registro({ grupo: 'hepatites-virais', agravo: 'B159', notificadoEm: diasAtras(3), nome: 'ELIAS HEPATITE UM QUARTA', notificationId: e1 });
    const re2 = await registro({ grupo: 'hepatites-virais', agravo: 'B159', notificadoEm: diasAtras(2), nome: 'ELOA HEPATITE DOIS QUARTA', notificationId: e2 });
    const e = (await criarSurto({ casosIndicados: [{ officialRecordId: re1.id }, { officialRecordId: re2.id }], grupo: 'hepatites-virais' }).expect(201)).body as Detalhe;
    const segundo = (await criarSurto({ assinatura: q, casosIndicados: [{ notificationId: e1 }, { notificationId: e2 }], grupo: 'hepatites-virais' }).expect(201)).body as Detalhe;
    // Antes: 201 sem esses avisos, e a mesma ocorrência ia ao Sinan em dobro sem ninguém ver.
    for (const n of [e1, e2]) expect(segundo.avisos).toContain(`A notificação ${await numero(n)} também está no surto ${e.numero}, pelo registro oficial conciliado com ela.`);
  });

  it('sur-4 e N11 na visão do núcleo: o caso que o núcleo não vê, no surto pelo registro conciliado, tira o agravo do evento inusitado', async () => {
    // Difteria, na visão do núcleo do hospital: o caso da UBS (que o núcleo não vê) está no surto pelo registro conciliado
    // com ele; o caso do hospital, achado depois com início antes dele, não é o "primeiro caso".
    const d1 = await notificar('medica', await novoPaciente('Dalva Difteria Quarta'), 'difteria', 6, 7);
    const rd = await registro({ grupo: 'difteria', agravo: 'A369', notificadoEm: diasAtras(6), nome: 'DALVA DIFTERIA QUARTA', notificationId: d1 });
    await criarSurto({ casosIndicados: [{ officialRecordId: rd.id }], grupo: 'difteria', casos: 1, localInicial: '1', primeirosSintomasEm: diasAtras(7) }).expect(201);
    const d0 = await notificar('medicaHosp', await novoPaciente('Duda Difteria Quarta'), 'difteria', 0, 9);
    // Antes: o núcleo via o d0 como "Primeiro caso do agravo registrado no município", e a vigilância, [d0, d1].
    expect(inusitado(await sugestoes('nucleo'), 'difteria')).toBeUndefined();
    expect((await sugestoes()).filter((s) => s.casos.includes(d0))).toEqual([]);
  });

  it('N11 e SURTO-5: a inclusão e a criação avisam o outro surto aberto pela própria origem e pelo outro lado do par', async () => {
    const lepto = { grupo: 'leptospirose', agravo: 'A279' };
    const n = await notificar('medica', await novoPaciente('Nuno Lepto Quarta'), 'leptospirose', 2, 3);
    const r = await registro({ ...lepto, notificadoEm: diasAtras(2), nome: 'NUNO LEPTO QUARTA', notificationId: n });
    const r2 = await registro({ ...lepto, notificadoEm: diasAtras(2), nome: 'OUTRO LEPTO QUARTA' });
    const m = await notificar('medica', await novoPaciente('Mara Lepto Quarta'), 'leptospirose', 2, 3);
    const rm = await registro({ ...lepto, notificadoEm: diasAtras(2), nome: 'MARA LEPTO QUARTA', notificationId: m });
    // Notificações confirmadas (o rascunho teria o aviso dele junto).
    await db.notification.updateMany({ where: { id: { in: [n, m] } }, data: { status: 'NOTIFICADA' } });
    const surto = async () => (await criarSurto({ grupo: 'leptospirose' }).expect(201)).body as Detalhe;
    const [s1, s2, s3, s4] = [await surto(), await surto(), await surto(), await surto()];
    await incluir(s1.id, { notificationId: n }).expect(201);
    await incluir(s1.id, { officialRecordId: r2.id }).expect(201);
    await incluir(s3.id, { officialRecordId: rm.id }).expect(201);
    const [numeroN, numeroM] = [await numero(n), await numero(m)];
    // O registro cuja notificação está no s1, e o registro que já está no s1. Antes: 201 com avisos [].
    expect((await incluir(s2.id, { officialRecordId: r.id }).expect(201)).body.avisos).toEqual([`O registro ${r.number} também está no surto ${s1.numero}, pela notificação conciliada com ele.`]);
    expect((await incluir(s2.id, { officialRecordId: r2.id }).expect(201)).body.avisos).toEqual([`O registro ${r2.number} também está no surto ${s1.numero}.`]);
    // A notificação cujo registro está no s3. Antes: avisos [] (só a própria notificação era procurada).
    expect((await incluir(s2.id, { notificationId: m }).expect(201)).body.avisos).toEqual([`A notificação ${numeroM} também está no surto ${s3.numero}, pelo registro oficial conciliado com ela.`]);
    // A notificação no s1 e o registro conciliado com ela no s2: os dois surtos.
    expect((await incluir(s4.id, { notificationId: n }).expect(201)).body.avisos).toEqual([
      `A notificação ${numeroN} também está no surto ${s1.numero}.`,
      `A notificação ${numeroN} também está no surto ${s2.numero}, pelo registro oficial conciliado com ela.`,
    ]);
    // Na criação ("Notificar surto"), pelo registro indicado: ele está no s1 e no s2.
    const criado = (await criarSurto({ grupo: 'leptospirose', casosIndicados: [{ officialRecordId: r2.id }] }).expect(201)).body as Detalhe;
    expect(criado.avisos).toEqual(expect.arrayContaining([`O registro ${r2.number} também está no surto ${s1.numero}.`, `O registro ${r2.number} também está no surto ${s2.numero}.`]));
    // O surto encerrado não conta (a planilha dele não muda mais): o rm está no s3, encerrado; a m, no s2, aberto.
    await t
      .http()
      .patch(`/api/vigilancia/surtos/${s3.id}`)
      .set(auth('vig'))
      .send({ investigacao: { investigadoEm: hoje() } })
      .expect(200);
    await t.http().post(`/api/vigilancia/surtos/${s3.id}/encerrar`).set(auth('vig')).send({ delimitacao: '8', data: hoje() }).expect(200);
    const s5 = await surto();
    expect((await incluir(s5.id, { officialRecordId: rm.id }).expect(201)).body.avisos).toEqual([`O registro ${rm.number} também está no surto ${s2.numero}, pela notificação conciliada com ele.`]);
  });

  it('SURTO-5 e N6: o vínculo feito depois de as duas linhas estarem na planilha é avisado no detalhe e no espelho, e o caso conta uma vez', async () => {
    const lepto = { grupo: 'leptospirose', agravo: 'A279' };
    const n = await notificar('medica', await novoPaciente('Rita Lepto Depois Quarta'), 'leptospirose', 2, 3);
    const r = await registro({ ...lepto, notificadoEm: diasAtras(2), nome: 'RITA LEPTO DEPOIS QUARTA' });
    const s = (await criarSurto({ grupo: 'leptospirose', casos: 30 }).expect(201)).body as Detalhe;
    await incluir(s.id, { notificationId: n }).expect(201);
    // Sem o vínculo, o registro entra: são duas pessoas para o sistema.
    await incluir(s.id, { officialRecordId: r.id }).expect(201);
    await incluir(s.id, { linha: { iniciais: 'MNL' } }).expect(201);
    const antes = await detalhe(s.id);
    expect([antes.casosNaPlanilha, antes.planilha.map((c) => c.mesmoCasoQue ?? null)]).toEqual([3, [null, null, null]]);
    await vincularNoBanco(r.id, n);
    const d = await detalhe(s.id);
    const aviso = 'Os casos 1 e 2 são o mesmo caso (notificação e registro conciliados): retire uma das linhas.';
    // Antes: casosNaPlanilha 3, "2 de 30" na regra dos 10%, nenhum aviso, e o espelho com a mesma pessoa duas vezes.
    expect(d.casosNaPlanilha).toBe(2);
    expect(d.avisos).toContain(aviso);
    expect(d.avisos.find((a) => a.includes('10%'))).toContain('(1 de 30)');
    expect(d.planilha.map((c) => [c.numero, c.mesmoCasoQue])).toEqual([
      [1, 2],
      [2, 1],
      [3, null],
    ]);
    // O espelho continua com as duas linhas (a vigilância decide qual retirar), com o aviso.
    expect(d.espelho.planilha.map((l) => l.NU_CASO)).toEqual(['1', '2', '3']);
    expect(d.espelho.avisos).toContain(aviso);
    const espelho = (await t.http().get(`/api/vigilancia/surtos/${s.id}/espelho`).set(auth('vig')).expect(200)).body as Espelho;
    expect([espelho.planilha.length, espelho.avisos.includes(aviso)]).toEqual([3, true]);
    // Na lista dos surtos, o mesmo.
    const lista = (await t.http().get('/api/vigilancia/surtos').set(auth('vig')).expect(200)).body as Detalhe[];
    expect(lista.find((x) => x.id === s.id)).toMatchObject({ casosNaPlanilha: 2, avisos: expect.arrayContaining([aviso]) });
    // Retirada uma das linhas, o aviso some.
    await t.http().delete(`/api/vigilancia/surtos/${s.id}/casos/${d.planilha[1]!.id}`).set(auth('vig')).expect(200);
    const depois = await detalhe(s.id);
    expect([depois.casosNaPlanilha, depois.avisos.some((a) => a.includes('mesmo caso')), depois.planilha.map((c) => c.mesmoCasoQue)]).toEqual([2, false, [null, null]]);
    // Surto já encerrado (a conciliação vincula o par depois do encerramento): a planilha não muda mais, e o aviso pede
    // a digitação de uma linha só no Sinan Net.
    const n2 = await notificar('medica', await novoPaciente('Raul Lepto Encerrado Quarta'), 'leptospirose', 2, 3);
    const r2 = await registro({ ...lepto, notificadoEm: diasAtras(2), nome: 'RAUL LEPTO ENCERRADO QUARTA' });
    const s2 = (await criarSurto({ grupo: 'leptospirose', casos: 2, casosIndicados: [{ notificationId: n2 }, { officialRecordId: r2.id }] }).expect(201)).body as Detalhe;
    await t
      .http()
      .patch(`/api/vigilancia/surtos/${s2.id}`)
      .set(auth('vig'))
      .send({ investigacao: { investigadoEm: hoje() } })
      .expect(200);
    await t.http().post(`/api/vigilancia/surtos/${s2.id}/encerrar`).set(auth('vig')).send({ delimitacao: '8', data: hoje() }).expect(200);
    await vincularNoBanco(r2.id, n2);
    const encerrado = await detalhe(s2.id);
    const avisoEncerrado = 'Os casos 1 e 2 são o mesmo caso (notificação e registro conciliados): digite só uma das linhas no Sinan Net.';
    expect([encerrado.status, encerrado.casosNaPlanilha, encerrado.avisos.includes(avisoEncerrado), encerrado.espelho.avisos.includes(avisoEncerrado)]).toEqual(['ENCERRADO', 1, true, true]);
  });

  it('trava: a inclusão segura a do surto (surto-caso:<id>), e nunca a da conciliação', async () => {
    const s = (await criarSurto({ grupo: 'coqueluche' }).expect(201)).body as Detalhe;
    const banco = (await db.$queryRawUnsafe<{ nome: string }[]>('SELECT current_database() AS nome'))[0]!.nome;
    const url = new URL(TEST_PG);
    url.pathname = `/${banco}`;
    const outra = new Client({ connectionString: url.toString() });
    await outra.connect();
    try {
      // Com a trava da conciliação presa (importação aplicando, por exemplo), a inclusão não espera por ela.
      await outra.query('BEGIN');
      await outra.query(`SELECT pg_advisory_xact_lock(hashtext('vigilancia:conciliacao'))`);
      await incluir(s.id, { linha: { iniciais: 'AAA' } })
        .timeout(10_000)
        .expect(201);
      await outra.query('ROLLBACK');
      // Com a trava do surto presa, a inclusão espera até ela ser solta.
      await outra.query('BEGIN');
      await outra.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`surto-caso:${s.id}`]);
      let pronta = false;
      const inclusao = incluir(s.id, { linha: { iniciais: 'BBB' } }).then((r) => {
        pronta = true;
        return r;
      });
      await pausa(800);
      expect(pronta).toBe(false);
      await outra.query('ROLLBACK');
      expect((await inclusao).status).toBe(201);
    } finally {
      await outra.query('ROLLBACK').catch(() => undefined);
      await outra.end();
    }
    expect((await detalhe(s.id)).planilha.map((c) => c.numero)).toEqual([1, 2]);
  });

  it('SURTO-2: a enchente de leptospirose (5001 em 24 h, agravo que as regras alcançam) não tira o evento inusitado da cólera', async () => {
    // Cólera, nunca vista: o primeiro caso, conhecido há 5 dias, é evento inusitado.
    const colera = await notificar('medica', await novoPaciente('Cesar Colera Quarta'), 'colera', 5, 6);
    expect(inusitado(await sugestoes(), 'colera')?.casos).toEqual([colera]);
    const molde = await notificar('medica', await novoPaciente('Lepto Molde Quarta'), 'leptospirose', 0, 1);
    await copiar(molde, 5000, 24 * H, 'R4L-');
    try {
      const r = await respostaSugestoes();
      // O teto cortou a cólera das regras de vizinhança (as 5000 mais recentes são de leptospirose)...
      expect(r.avisos.find((a) => a.startsWith('Mais de 5000'))).toContain('Cólera');
      // ...mas o evento inusitado é avaliado à parte. Antes: o inusitado da cólera sumia, e nenhum aviso dizia isso.
      expect(inusitado(r.sugestoes, 'colera')?.casos).toEqual([colera]);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM notifications WHERE number LIKE 'R4L-%'`);
    }
  }, 240_000);

  it('SURTO-2: a onda de covid (5001 em 72 h, na regra de síndrome gripal e nas de quarteirão e bairro) não tira o evento inusitado do botulismo', async () => {
    const botulismo = await notificar('medica', await novoPaciente('Bento Botulismo Quarta'), 'botulismo', 5, 6);
    expect(inusitado(await sugestoes(), 'botulismo')?.casos).toEqual([botulismo]);
    // A ficha da covid pede outros campos: a notificação de leptospirose vira o molde da covid pelo banco.
    const molde = await notificar('medica', await novoPaciente('Covid Molde Quarta'), 'leptospirose', 0, 1);
    const covid = await db.notifiableCondition.findFirstOrThrow({ where: { key: 'covid-19' }, select: { id: true, key: true, groupKey: true } });
    await db.notification.update({ where: { id: molde }, data: { status: 'NOTIFICADA', conditionId: covid.id, conditionKey: covid.key, groupKey: covid.groupKey } });
    await copiar(molde, 5000, 72 * H, 'R4C-');
    try {
      const r = await respostaSugestoes();
      expect(r.avisos.find((a) => a.startsWith('Mais de 5000'))).toContain('Botulismo');
      // Antes: o inusitado do botulismo sumia; a covid, nunca vista, também é inusitada, e as duas são avaliadas.
      expect(inusitado(r.sugestoes, 'botulismo')?.casos).toEqual([botulismo]);
      expect(inusitado(r.sugestoes, covid.groupKey)?.casos).toHaveLength(5001);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM notifications WHERE number LIKE 'R4C-%'`);
    }
  }, 240_000);
});
