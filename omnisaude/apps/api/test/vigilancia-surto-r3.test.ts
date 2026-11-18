import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { SurtoService } from '../src/modules/vigilancia/surto.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Surto (VIG-1c), terceira rodada da semana 27: o caso índice achado depois do caso em surto não reabre o evento
 * inusitado (sur-4); a dispensa vale até o último caso que a tela mostrou (SURTO-1); o teto das sugestões lê só os
 * grupos das regras de vizinhança, e a dengue não passa pela localização (SURTO-2 e a primeira metade do SURTO-6); a
 * planilha só muda com o surto aberto (SURTO-3); o NU_CASO não é reaproveitado (SURTO-4); e o registro oficial
 * conciliado com a notificação é o mesmo caso (SURTO-5).
 */
const enabled = await pgAvailable();
const H = 3_600_000;
const DIA = 24 * H;
const TZ = 'America/Sao_Paulo';
const hoje = () => localDateString(new Date(), TZ);
const diasAtras = (n: number) => localDateString(new Date(Date.now() - n * DIA), TZ);
const pausa = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

type Sugestao = { assinatura: string; regra: string; grupo: string; descricao: string; casos: string[]; ultimoConhecimento: string; casosDetalhe: { id: string; bairro: string | null }[] };
type Caso = { id: string; numero: number; notificationId: string | null; officialRecordId: string | null };
type Detalhe = { id: string; numero: string; status: string; planilha: Caso[]; eventos: { tipo: string; dados: Record<string, unknown> }[] };
type ItemBusca = { id: string; emSurtos: string[] };

describe.runIf(enabled)('Vigilância: surto, terceira rodada (semana 27)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let surtos: SurtoService;
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
  const dispensar = (corpo: Record<string, unknown>) => t.http().post('/api/vigilancia/surtos/sugestoes/dispensar').set(auth('vig')).send(corpo);
  const novoPaciente = async (nome: string) => {
    seq++;
    const body = {
      name: nome,
      birthDate: `${1960 + (seq % 40)}-0${1 + (seq % 9)}-1${seq % 8}`,
      sex: seq % 2 ? 'M' : 'F',
      cpf: completeCpf(String(273000700 + seq)),
      cns: cnsFromBase(String(27300000700 + seq)),
      motherName: `Mae de ${nome}`,
      phone: '(11) 97777-2703',
      address: { cep: '01001000', street: 'Rua da Terceira Rodada', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
      confirmNotDuplicate: true,
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  /** Bairro novo com os quarteirões pedidos (cada um num ponto próprio). */
  const bairro = async (nome: string, quarteiroes: string[]) => {
    const b = await db.neighborhood.create({ data: { localityId: loc, name: nome } });
    for (const numero of quarteiroes) {
      const k = Object.keys(Q).length;
      const lat = -23.8 - k * 0.01;
      const lng = -46.9 - k * 0.01;
      const q = await db.block.create({
        data: {
          localityId: loc,
          neighborhoodId: b.id,
          number: numero,
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
      Q[numero] = { id: q.id, centerLat: q.centerLat, centerLng: q.centerLng };
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
      data: { street: 'Rua da Terceira Rodada', number: String(seq), ibgeCode: '3550308', latitude: Q[q]!.centerLat, longitude: Q[q]!.centerLng, blockId: Q[q]!.id, families: { create: { responsibleId: p } } },
      include: { families: true },
    });
    await db.patient.update({ where: { id: p }, data: { familyId: h.families[0]!.id } });
    return notificar('medica', p, grupo, conhecidoHaDias, sintomasHaDias);
  };
  /**
   * Cópias da notificação (mesmo paciente, agravo e posição), conhecidas ao acaso nas últimas `janelaMs`, por SQL. A
   * numeração segue o maior `seq` do banco (a notificação criada depois pela API pega o seguinte).
   */
  const copiar = async (molde: string, n: number, janelaMs: number) => {
    const inicio = (await db.$queryRawUnsafe<{ inicio: number }[]>(`SELECT COALESCE(max(seq), 0)::int AS inicio FROM notifications`))[0]!.inicio;
    await db.$executeRawUnsafe(
      `INSERT INTO notifications (id, year, seq, number, status, origin, condition_id, condition_key, group_key, basis, code_system, code, map_status, patient_id, unit_id, notifier_id, notifier_cbo, notifier_role, first_care_at, known_at, confirmed_at, deadline_start, deadline_kind, targets, deadline_start_at, due_at, notified_at, symptoms_onset, epi_week_notified, epi_week_onset, sensitive, form, residence_ibge, residence_lat, residence_lng, out_of_municipality, created_by, created_at, updated_at, residence_precision)
       SELECT gen_random_uuid(), year, ${inicio} + g, 'R3-' || (${inicio} + g), status, origin, condition_id, condition_key, group_key, basis, code_system, code, map_status, patient_id, unit_id, notifier_id, notifier_cbo, notifier_role, first_care_at,
              now() AT TIME ZONE 'UTC' - (random() * ${janelaMs} || ' milliseconds')::interval, confirmed_at, deadline_start, deadline_kind, targets, deadline_start_at, due_at, notified_at, symptoms_onset, epi_week_notified, epi_week_onset, sensitive, '{}'::jsonb, residence_ibge,
              residence_lat + (random() - 0.5) * 0.004, residence_lng + (random() - 0.5) * 0.004, out_of_municipality, created_by, created_at, updated_at, residence_precision
       FROM notifications, generate_series(1, ${n}) g WHERE id = '${molde}'::uuid`,
    );
  };
  /** Registro oficial individual gravado direto no banco (como a importação aplicada o deixaria), conciliado ou não. */
  const registro = async (o: { grupo: string; agravo: string; notificadoEm: string; nome: string; notificationId?: string }) => {
    nReg++;
    return db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: 'INDIVIDUAL',
        naturalKey: `r3sur-${nReg}`,
        number: String(8_300_000 + nReg),
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
  const base = () => ({ notificadoEm: hoje(), conhecidoEm: new Date(Date.now() - H).toISOString(), primeirosSintomasEm: diasAtras(3), casos: 2, localInicial: '8' });
  const novoSurto = async (extra: Record<string, unknown> = {}) =>
    (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('vig'))
        .send({ ...base(), categoria: 'FORA_DA_LISTA', cid: 'B08.4', agente: 'Mão-pé-boca na creche', unitId: U.ubs!.id, localInicial: '3', ...extra })
        .expect(201)
    ).body as Detalhe;
  const investigar = (id: string) =>
    t
      .http()
      .patch(`/api/vigilancia/surtos/${id}`)
      .set(auth('vig'))
      .send({ investigacao: { investigadoEm: hoje() } })
      .expect(200);
  const encerrar = (id: string) => t.http().post(`/api/vigilancia/surtos/${id}/encerrar`).set(auth('vig')).send({ delimitacao: '8', data: hoje() });
  const incluir = (id: string, corpo: Record<string, unknown>) => t.http().post(`/api/vigilancia/surtos/${id}/casos`).set(auth('vig')).send(corpo);
  const retirar = (id: string, caso: string) => t.http().delete(`/api/vigilancia/surtos/${id}/casos/${caso}`).set(auth('vig'));
  const linhaDoTempo = (d: Detalhe) => d.eventos.map((e) => (e.tipo.startsWith('CASO_') ? `${e.tipo}:${String(e.dados.caso)}` : e.tipo));

  beforeAll(async () => {
    t = await startTestApp('vigsurtor3');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.medicaHosp = await t.login('medica', 'Hospital Municipal São Lucas', 'MEDICO');
    tk.nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    surtos = t.app.get(SurtoService);
    for (const u of demoFixtures.UNITS) U[u.key] = { id: (await db.unit.findUniqueOrThrow({ where: { cnes: u.cnes } })).id, cnes: u.cnes };
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
    for (const tabela of ['outbreak_cases', 'outbreak_events', 'outbreak_dismissals', 'outbreaks']) await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
    loc = (await db.locality.create({ data: { code: '973', name: 'Localidade Terceira Rodada', category: 'CIDADE', zone: 'URBANA', source: 'MANUAL' } })).id;
    await bairro('Bairro R3 S', ['S1', 'S2']);
    importacao = (await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'r3sur.zip', sha256: 'f'.repeat(64), sizeBytes: 1, createdBy: usuario.vigilancia! } })).id;
    // Histórico anterior à janela (sem ele, o evento inusitado não é avaliado).
    const antigo = await notificar('medica', await novoPaciente('Otavio Historico Terceira'), 'coqueluche', 0, null);
    await db.notification.update({ where: { id: antigo }, data: { knownAt: new Date(Date.now() - 60 * DIA) } });
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
  });

  it('sur-4: o caso índice achado depois pela busca ativa, com início antes do caso em surto, não reabre o "primeiro caso" (nem na visão do núcleo)', async () => {
    // Cólera: o c1 (início há 7 dias) virou surto; a busca ativa acha hoje o c0, com início há 9 dias, e chega o c2.
    const c1 = await notificar('medica', await novoPaciente('Celio Colera Surto'), 'colera', 6, 7);
    const s1 = inusitado(await sugestoes(), 'colera')!;
    expect(s1.casos).toEqual([c1]);
    const surtoColera = {
      ...base(),
      assinatura: s1.assinatura,
      casosIndicados: [{ notificationId: c1 }],
      categoria: 'DA_LISTA',
      grupo: 'colera',
      unitId: U.ubs!.id,
      primeirosSintomasEm: diasAtras(7),
      casos: 1,
      localInicial: '1',
    };
    await t.http().post('/api/vigilancia/surtos').set(auth('vig')).send(surtoColera).expect(201);
    const c0 = await notificar('medica', await novoPaciente('Caio Colera Indice'), 'colera', 0, 9);
    const c2 = await notificar('medica', await novoPaciente('Cora Colera Depois'), 'colera', 0, 1);
    // Antes: voltava "Primeiro caso do agravo registrado no município" com [c0, c2], convidando a abrir outro surto.
    const lista = await sugestoes();
    expect(inusitado(lista, 'colera')).toBeUndefined();
    expect(lista.filter((s) => s.casos.some((c) => [c0, c2].includes(c)))).toEqual([]);
    // Difteria: o caso em surto é da UBS, que o núcleo do hospital não vê; o caso índice, achado depois, é do hospital.
    const d1 = await notificar('medica', await novoPaciente('Dalva Difteria Ubs'), 'difteria', 6, 7);
    const sd = inusitado(await sugestoes(), 'difteria')!;
    expect(sd.casos).toEqual([d1]);
    await t
      .http()
      .post('/api/vigilancia/surtos')
      .set(auth('vig'))
      .send({ ...surtoColera, assinatura: sd.assinatura, casosIndicados: [{ notificationId: d1 }], grupo: 'difteria' })
      .expect(201);
    const d0 = await notificar('medicaHosp', await novoPaciente('Duda Difteria Hospital'), 'difteria', 0, 9);
    // Antes: o núcleo via o d0 como "Primeiro caso do agravo registrado no município" (o d1 é posterior a ele).
    expect(inusitado(await sugestoes('nucleo'), 'difteria')).toBeUndefined();
    expect((await sugestoes()).filter((s) => s.casos.includes(d0))).toEqual([]);
  });

  it('SURTO-1: a dispensa vale até o último caso que a tela mostrou; o caso que chegou depois de a tela abrir dá 409', async () => {
    const v1 = await notificar('medicaHosp', await novoPaciente('Vera Varicela Um'), 'varicela', 2, 3);
    const a = `varicela-hospitalar|UNIDADE:${U.hosp!.id}|varicela`;
    const tela = (await sugestoes()).find((s) => s.assinatura === a)!;
    expect(tela.casos).toEqual([v1]);
    // Chega o segundo caso de varicela no hospital depois de a tela carregar, e a vigilância dispensa com o motivo do 1º.
    const v2 = await notificar('medicaHosp', await novoPaciente('Vitor Varicela Dois'), 'varicela', 0, 1);
    const motivo = 'Caso investigado: sem contato com outros pacientes.';
    const r = await dispensar({ assinatura: a, motivo, ultimoConhecimento: tela.ultimoConhecimento });
    // Antes: 200, com a dispensa até o conhecimento do v2 (que a tela nunca mostrou), e a sugestão sumia.
    expect([r.status, r.body.message]).toEqual([409, 'A sugestão mudou desde que a tela foi aberta: abra de novo.']);
    expect(await db.outbreakDismissal.count({ where: { signature: a } })).toBe(0);
    const nova = (await sugestoes()).find((s) => s.assinatura === a)!;
    expect([...nova.casos].sort()).toEqual([v1, v2].sort());
    // O limite futuro esconderia os casos que ainda vão chegar.
    expect((await dispensar({ assinatura: a, motivo, ultimoConhecimento: new Date(Date.now() + DIA).toISOString() })).status).toBe(400);
    // Com a tela nova, a dispensa grava o último caso que ela mostrou e a sugestão some até chegar caso depois dele.
    expect((await dispensar({ assinatura: a, motivo, ultimoConhecimento: nova.ultimoConhecimento })).status).toBe(200);
    expect((await db.outbreakDismissal.findFirstOrThrow({ where: { signature: a } })).untilKnownAt.toISOString()).toBe(nova.ultimoConhecimento);
    expect((await sugestoes()).find((s) => s.assinatura === a)).toBeUndefined();
  });

  it('SURTO-3: a inclusão e a retirada conferem o surto aberto na transação; o encerramento e o descarte esperam por elas', async () => {
    const srv = surtos as unknown as {
      prepararCaso: (...a: unknown[]) => Promise<unknown>;
      carregar: (...a: unknown[]) => Promise<unknown>;
      proximoNumeroCaso: (...a: unknown[]) => Promise<number>;
    };
    // (a) A inclusão começa, e o surto é encerrado antes de ela gravar: 409, e a planilha do encerrado fica como estava.
    const s = await novoSurto();
    await investigar(s.id);
    const n = await notificar('medica', await novoPaciente('Nair Corrida Encerra'), 'coqueluche', 1, 2);
    const preparar = srv.prepararCaso.bind(surtos);
    const espera = vi.spyOn(srv, 'prepararCaso').mockImplementation(async (...a: unknown[]) => {
      const r = await preparar(...a);
      await pausa(400);
      return r;
    });
    const [ri, re] = await Promise.all([incluir(s.id, { notificationId: n }), pausa(150).then(() => encerrar(s.id))]).finally(() => espera.mockRestore());
    // Antes: [201, 200], com a linha no surto encerrado e o "Caso incluído" depois do encerramento.
    expect([ri.status, ri.body.code, ri.body.message, re.status]).toEqual([409, 'SURTO_FECHADO', 'O surto foi encerrado enquanto a planilha mudava: abra de novo', 200]);
    const d = await detalhe(s.id);
    expect([d.status, d.planilha.length, linhaDoTempo(d)]).toEqual(['ENCERRADO', 0, ['CRIADO', 'INVESTIGADO', 'ENCERRADO']]);
    // (b) A retirada começa, e o surto é descartado antes de ela gravar: 409, e a linha fica.
    const s2 = await novoSurto();
    const c = (await incluir(s2.id, { linha: { iniciais: 'RRR' } }).expect(201)).body.caso as Caso;
    const carregar = srv.carregar.bind(surtos);
    let atrasar = true;
    const espera2 = vi.spyOn(srv, 'carregar').mockImplementation(async (...a: unknown[]) => {
      const r = await carregar(...a);
      if (atrasar) {
        atrasar = false;
        await pausa(300);
      }
      return r;
    });
    const [rr, rd] = await Promise.all([
      retirar(s2.id, c.id),
      pausa(120).then(() => t.http().post(`/api/vigilancia/surtos/${s2.id}/descartar`).set(auth('vig')).send({ motivo: 'Não é surto: casos sem vínculo entre si.' })),
    ]).finally(() => espera2.mockRestore());
    expect([rr.status, rr.body.message, rd.status]).toEqual([409, 'O surto foi descartado enquanto a planilha mudava: abra de novo', 200]);
    const d2 = await detalhe(s2.id);
    expect([d2.status, d2.planilha.map((x) => x.id), linhaDoTempo(d2)]).toEqual(['DESCARTADO', [c.id], ['CRIADO', 'CASO_VINCULADO:1', 'DESCARTADO']]);
    // (c) Com a inclusão já dentro da transação (linha do surto presa), o encerramento espera: os dois valem, na ordem.
    const s3 = await novoSurto();
    await investigar(s3.id);
    const proximo = srv.proximoNumeroCaso.bind(surtos);
    const espera3 = vi.spyOn(srv, 'proximoNumeroCaso').mockImplementation(async (...a: unknown[]) => {
      const r = await proximo(...a);
      await pausa(400);
      return r;
    });
    const [ri3, re3] = await Promise.all([incluir(s3.id, { linha: { iniciais: 'TTT' } }), pausa(150).then(() => encerrar(s3.id))]).finally(() => espera3.mockRestore());
    expect([ri3.status, re3.status]).toEqual([201, 200]);
    const d3 = await detalhe(s3.id);
    expect([d3.status, d3.planilha.length, linhaDoTempo(d3)]).toEqual(['ENCERRADO', 1, ['CRIADO', 'INVESTIGADO', 'CASO_VINCULADO:1', 'ENCERRADO']]);
  });

  it('SURTO-4: o NU_CASO de uma linha retirada não volta com outra pessoa', async () => {
    const s = await novoSurto();
    const um = (await incluir(s.id, { linha: { iniciais: 'AAA' } }).expect(201)).body.caso as Caso;
    const dois = (await incluir(s.id, { linha: { iniciais: 'BBB' } }).expect(201)).body.caso as Caso;
    await retirar(s.id, dois.id).expect(200);
    const tres = (await incluir(s.id, { linha: { iniciais: 'CCC' } }).expect(201)).body.caso as Caso;
    // Antes: [1, 2, 2], com "Caso retirado 2" e "Caso incluído 2" de pessoas diferentes na linha do tempo.
    expect([um.numero, dois.numero, tres.numero]).toEqual([1, 2, 3]);
    // Com a planilha vazia, o número segue o maior já usado no surto.
    await retirar(s.id, tres.id).expect(200);
    await retirar(s.id, um.id).expect(200);
    const quatro = (await incluir(s.id, { linha: { iniciais: 'DDD' } }).expect(201)).body.caso as Caso;
    expect(quatro.numero).toBe(4);
    const d = await detalhe(s.id);
    expect(linhaDoTempo(d)).toEqual(['CRIADO', 'CASO_VINCULADO:1', 'CASO_VINCULADO:2', 'CASO_RETIRADO:2', 'CASO_VINCULADO:3', 'CASO_RETIRADO:3', 'CASO_RETIRADO:1', 'CASO_VINCULADO:4']);
    expect(d.planilha.map((x) => x.numero)).toEqual([4]);
  });

  it('SURTO-5: o registro oficial conciliado com a notificação é o mesmo caso, nos dois sentidos', async () => {
    const n = await notificar('medica', await novoPaciente('Rui Barbosa Par'), 'leptospirose', 2, 3);
    const numeroN = (await db.notification.findUniqueOrThrow({ where: { id: n } })).number;
    const r = await registro({ grupo: 'leptospirose', agravo: 'A279', notificadoEm: diasAtras(2), nome: 'RUI BARBOSA PAR', notificationId: n });
    const daLista = { categoria: 'DA_LISTA', grupo: 'leptospirose', cid: null, agente: null };
    // (a) A notificação está na planilha: o registro conciliado com ela sai da busca do surto e não entra.
    const s = await novoSurto(daLista);
    await incluir(s.id, { notificationId: n }).expect(201);
    const busca = (await t.http().get(`/api/vigilancia/surtos/registros?surtoId=${s.id}&grupo=leptospirose`).set(auth('vig')).expect(200)).body as { itens: ItemBusca[] };
    // Antes: o registro aparecia com emSurtos [] e entrava com 201 (a mesma pessoa duas vezes na planilha).
    expect(busca.itens.map((i) => i.id)).not.toContain(r.id);
    const doRegistro = await incluir(s.id, { officialRecordId: r.id });
    expect([doRegistro.status, doRegistro.body.message]).toEqual([409, `O registro ${r.number} é o mesmo caso da notificação conciliada com ele, que já está na planilha deste surto (caso 1)`]);
    expect((await detalhe(s.id)).planilha.map((c) => [c.numero, c.notificationId, c.officialRecordId])).toEqual([[1, n, null]]);
    // Fora da busca do surto, o registro vem marcado com o surto da notificação conciliada.
    const geral = (await t.http().get('/api/vigilancia/surtos/registros?grupo=leptospirose').set(auth('vig')).expect(200)).body as { itens: ItemBusca[] };
    expect(geral.itens.find((i) => i.id === r.id)?.emSurtos).toEqual([s.numero]);
    // (b) O registro está na planilha: a notificação conciliada com ele sai das candidatas do surto e não entra.
    const s2 = await novoSurto(daLista);
    await incluir(s2.id, { officialRecordId: r.id }).expect(201);
    const candidatas = (
      await t
        .http()
        .get(`/api/vigilancia/surtos/candidatas?surtoId=${s2.id}&busca=${encodeURIComponent(numeroN)}`)
        .set(auth('vig'))
        .expect(200)
    ).body as { itens: ItemBusca[] };
    expect(candidatas.itens.map((i) => i.id)).not.toContain(n);
    const daNotificacao = await incluir(s2.id, { notificationId: n });
    expect([daNotificacao.status, daNotificacao.body.message]).toEqual([409, `A notificação ${numeroN} é o mesmo caso do registro oficial conciliado com ela, que já está na planilha deste surto (caso 1)`]);
    expect((await detalhe(s2.id)).planilha.map((c) => [c.numero, c.notificationId, c.officialRecordId])).toEqual([[1, null, r.id]]);
    // Fora da busca do surto, a notificação vem com os dois surtos: o dela e o do registro conciliado.
    const todas = (
      await t
        .http()
        .get(`/api/vigilancia/surtos/candidatas?busca=${encodeURIComponent(numeroN)}`)
        .set(auth('vig'))
        .expect(200)
    ).body as { itens: ItemBusca[] };
    expect(todas.itens.find((i) => i.id === n)?.emSurtos).toEqual([s.numero, s2.numero].sort());
    // O registro sem conciliação continua entrando, ao lado da notificação de outra pessoa.
    const outro = await registro({ grupo: 'leptospirose', agravo: 'A279', notificadoEm: diasAtras(1), nome: 'OUTRA PESSOA' });
    expect((await incluir(s.id, { officialRecordId: outro.id }).expect(201)).body.caso).toMatchObject({ numero: 2, officialRecordId: outro.id });
    // (c) Na criação do surto, a notificação e o registro conciliado com ela indicados juntos: só um dos dois entra.
    const antes = await db.outbreak.count();
    const criacao = await t
      .http()
      .post('/api/vigilancia/surtos')
      .set(auth('vig'))
      .send({ ...base(), ...daLista, casosIndicados: [{ notificationId: n }, { officialRecordId: r.id }], unitId: U.ubs!.id, localInicial: '3' });
    expect([criacao.status, criacao.body.message]).toEqual([409, `O registro ${r.number} é o mesmo caso de uma das notificações indicadas (conciliada com ele): indique só um dos dois`]);
    expect(await db.outbreak.count()).toBe(antes);
  });

  it('SURTO-2: com 5101 notificações de dengue em 48 h, o aglomerado de esquistossomose continua; o teto só corta as regras de vizinhança e diz quais agravos ficaram de fora', async () => {
    // Aglomerado de esquistossomose no S1, com casos conhecidos há 4 e 3 dias.
    const e1 = await casoNoQuarteirao('Ester Esquisto Um', 'esquistossomose', 'S1', 4, 5);
    const e2 = await casoNoQuarteirao('Elton Esquisto Dois', 'esquistossomose', 'S1', 3, 4);
    const q = `quarteirao-7d|QUARTEIRAO:${Q.S1!.id}|esquistossomose`;
    expect([...(await sugestoes()).find((s) => s.assinatura === q)!.casos].sort()).toEqual([e1, e2].sort());
    // Dengue e chikungunya já vistas antes da janela; a Zika nunca vista, com um caso no S2.
    for (const [nome, grupo] of [
      ['Dino Dengue Antigo', 'dengue'],
      ['Chico Chik Antigo', 'chikungunya'],
    ] as const) {
      const antigo = await notificar('medica', await novoPaciente(nome), grupo, 0, null);
      await db.notification.update({ where: { id: antigo }, data: { knownAt: new Date(Date.now() - 60 * DIA) } });
    }
    await notificar('medica', await novoPaciente('Chaves Chik Novo'), 'chikungunya', 1, 2);
    const zika = await casoNoQuarteirao('Zuza Zika Nova', 'zika', 'S2', 1, 2);
    // A epidemia: 5101 notificações de dengue nas últimas 48 h, com a posição GPS na ficha (sem quarteirão ligado).
    const molde = await notificar('medica', await novoPaciente('Dengue Molde Terceira'), 'dengue', 0, 1);
    await db.notification.update({ where: { id: molde }, data: { status: 'NOTIFICADA', residenceLat: Q.S2!.centerLat, residenceLng: Q.S2!.centerLng, residencePrecision: 'GPS_CAMPO' } });
    await copiar(molde, 5100, 48 * H);
    const srv = surtos as unknown as { territorioDasNotificacoes: (db: unknown, ns: { id: string; groupKey: string }[]) => Promise<unknown> };
    const territorio = vi.spyOn(srv, 'territorioDasNotificacoes');
    const r = await respostaSugestoes().finally(() => territorio.mockRestore());
    // Antes: as 5000 mais recentes eram de dengue, o aglomerado sumia e o aviso só dizia "só as mais recentes entraram".
    expect([...r.sugestoes.find((s) => s.assinatura === q)!.casos].sort()).toEqual([e1, e2].sort());
    expect(r.avisos.filter((a) => a.startsWith('Mais de 5000'))).toEqual([]);
    // A dengue não passa pela localização no território (nenhuma regra de vizinhança a usa): antes, as 5000 passavam.
    const resolvidas = territorio.mock.calls.flatMap((c) => c[1]);
    expect(resolvidas.filter((x) => x.groupKey === 'dengue')).toEqual([]);
    expect(resolvidas.length).toBeLessThan(100);
    // Evento inusitado dos grupos fora das regras: a Zika, nunca vista, aparece com o bairro; dengue e chikungunya, não.
    expect(inusitado(r.sugestoes, 'zika')).toMatchObject({ casos: [zika], casosDetalhe: [{ id: zika, bairro: 'Bairro R3 S' }] });
    expect(inusitado(r.sugestoes, 'dengue')).toBeUndefined();
    expect(inusitado(r.sugestoes, 'chikungunya')).toBeUndefined();
    // O teto vale para as regras de vizinhança: com 5001 de leptospirose nas últimas 24 h, o aviso diz os agravos cortados.
    const lepto = await notificar('medica', await novoPaciente('Lepto Molde Terceira'), 'leptospirose', 0, 1);
    await copiar(lepto, 5000, 24 * H);
    const aviso = (await respostaSugestoes()).avisos.find((a) => a.startsWith('Mais de 5000'));
    expect(aviso).toMatch(/^Mais de 5000 notificações nos últimos 30 dias: só as mais recentes entraram nas regras de quarteirão, bairro e unidade, e ficaram de fora casos de .+\.$/);
    expect(aviso).toContain('Esquistossomose');
    expect(aviso).toContain('Leptospirose');
    expect(aviso).not.toContain('dengue');
  }, 240_000);
});
