import { canonicalJson, demoFixtures, sha256 } from '@omnisaude/database';
import { cnsFromBase, completeCpf, fromZonedParts, localDateString } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { SurtoService } from '../src/modules/vigilancia/surto.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Surto (VIG-1c): correções da revisão adversarial da semana 27. Dispensa com escopo (sur-1, tra-1), histórico sem os
 * descartados (sur-3), caso já em surto como caso anterior do evento inusitado (sur-4), caso de surto encerrado ou
 * descartado fora das sugestões (sur-5), dia local do conhecimento (sur-9), linha sigilosa mascarada (tra-4), planilha
 * sem o mesmo registro duas vezes (tra-7), datas do espelho em dd/mm/aaaa (K7) e bloco DTA conferido pelo shared (K8).
 */
const enabled = await pgAvailable();
const H = 3_600_000;
const DIA = 24 * H;
const TZ = 'America/Sao_Paulo';
const hoje = () => localDateString(new Date(), TZ);
const diasAtras = (n: number) => localDateString(new Date(Date.now() - n * DIA), TZ);
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

type Sugestao = { assinatura: string; regra: string; grupo: string; descricao: string; vinculo: { tipo: string; id: string }; casos: string[] };
type Caso = {
  id: string;
  numero: number;
  notificationId: string | null;
  officialRecordId: string | null;
  notificacaoNumero: string | null;
  iniciais: string | null;
  sexo: string | null;
  idade: string | null;
  inicioSintomas: string | null;
  restrito: boolean;
};
type Detalhe = {
  id: string;
  numero: string;
  status: string;
  planilha: Caso[];
  eventos: { tipo: string; dados: Record<string, unknown> }[];
  espelho: { campos: { variavel: string; valor: string | null }[]; planilha: Record<string, string | null>[]; dta: { variavel: string; rotulo: string; valor: string | null }[]; avisos: string[] };
};

describe.runIf(enabled)('Vigilância: correções do surto (semana 27, revisão adversarial)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let surtos: SurtoService;
  const tk: Record<string, string> = {};
  const U: Record<string, { id: string; cnes: string }> = {};
  const usuario: Record<string, string> = {};
  const B: Record<string, string> = {};
  const Q: Record<string, { id: string; centerLat: number; centerLng: number }> = {};
  let loc = '';
  let seq = 0;
  let nReg = 0;
  let importacao = '';
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const sugestoes = async (k = 'vig') => ((await t.http().get('/api/vigilancia/surtos/sugestoes').set(auth(k)).expect(200)).body as { sugestoes: Sugestao[] }).sugestoes;
  const assinatura = (lista: Sugestao[], a: string) => lista.find((s) => s.assinatura === a);
  const inusitado = (lista: Sugestao[], grupo: string) => lista.find((s) => s.regra === 'inusitado' && s.grupo === grupo);
  const criar = async (k: string, corpo: Record<string, unknown>) => (await t.http().post('/api/vigilancia/surtos').set(auth(k)).send(corpo).expect(201)).body as Detalhe;
  const detalhe = async (id: string, k = 'vig') => (await t.http().get(`/api/vigilancia/surtos/${id}`).set(auth(k)).expect(200)).body as Detalhe;
  const novoPaciente = async (nome: string, sex: 'M' | 'F' = 'M', birthDate?: string) => {
    seq++;
    const body = {
      name: nome,
      birthDate: birthDate ?? `${1960 + seq}-0${1 + (seq % 9)}-1${seq % 8}`,
      sex,
      cpf: completeCpf(String(272000700 + seq)),
      cns: cnsFromBase(String(27200000700 + seq)),
      motherName: `Mae de ${nome}`,
      phone: '(11) 97777-2702',
      address: { cep: '01001000', street: 'Rua da Revisao', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
      confirmNotDuplicate: true,
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  /** Bairro novo com os quarteirões pedidos (cada um num ponto próprio). */
  const bairro = async (nome: string, quarteiroes: string[]) => {
    const b = await db.neighborhood.create({ data: { localityId: loc, name: nome } });
    B[nome] = b.id;
    for (const numero of quarteiroes) {
      const k = Object.keys(Q).length;
      const lat = -23.5 - k * 0.01;
      const lng = -46.6 - k * 0.01;
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
  const morarEm = async (patientId: string, q: string) => {
    const h = await db.household.create({
      data: { street: 'Rua da Revisao', number: String(seq), ibgeCode: '3550308', latitude: Q[q]!.centerLat, longitude: Q[q]!.centerLng, blockId: Q[q]!.id, families: { create: { responsibleId: patientId } } },
      include: { families: true },
    });
    await db.patient.update({ where: { id: patientId }, data: { familyId: h.families[0]!.id } });
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
  /** Caso de quem mora no quarteirão. */
  const casoNoQuarteirao = async (k: string, nome: string, grupo: string, q: string, conhecidoHaDias: number, sintomasHaDias: number | null) => {
    const p = await novoPaciente(nome);
    await morarEm(p, q);
    return notificar(k, p, grupo, conhecidoHaDias, sintomasHaDias);
  };
  /** Registro oficial individual gravado direto no banco (como a importação aplicada o deixaria). */
  const registro = async (o: {
    grupo: string;
    agravo: string;
    notificadoEm: string;
    situacao?: string;
    sensivel?: boolean;
    unidade?: string | null;
    cnes?: string | null;
    nome?: string;
    sexo?: string;
    nascimento?: string;
  }) => {
    nReg++;
    return db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: 'INDIVIDUAL',
        naturalKey: `c27c1-${nReg}`,
        number: String(8_100_000 + nReg),
        notifiedOn: new Date(`${o.notificadoEm}T00:00:00Z`),
        municipalityIbge: '355030',
        unitCnes: o.cnes ?? null,
        unitId: o.unidade ?? null,
        agravo: o.agravo,
        groupKey: o.grupo,
        residenceIbge: '355030',
        situation: o.situacao ?? 'CONFIRMADO',
        sensitive: o.sensivel ?? false,
        patientName: o.nome ?? null,
        sex: o.sexo ?? null,
        birthDate: o.nascimento ? new Date(`${o.nascimento}T00:00:00Z`) : null,
        contentHash: '0'.repeat(64),
        firstImportId: importacao,
        lastImportId: importacao,
        lastSeenAt: new Date(),
      },
    });
  };
  const base = { notificadoEm: hoje(), conhecidoEm: new Date(Date.now() - H).toISOString(), primeirosSintomasEm: diasAtras(3), casos: 2, localInicial: '8' };

  beforeAll(async () => {
    t = await startTestApp('vigsurtocorr');
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
    loc = (await db.locality.create({ data: { code: '978', name: 'Localidade Revisao Surto', category: 'CIDADE', zone: 'URBANA', source: 'MANUAL' } })).id;
    await bairro('Bairro Gama', ['G1', 'G2', 'G3']);
    await bairro('Bairro Epsilon', ['E1']);
    await bairro('Bairro Zeta', ['Z1']);
    await bairro('Bairro Kappa', ['K1']);
    importacao = (await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'c27c1.zip', sha256: 'c'.repeat(64), sizeBytes: 1, createdBy: usuario.vigilancia! } })).id;
    // Histórico anterior à janela (sem ele, o evento inusitado não é avaliado).
    const antigo = await notificar('medica', await novoPaciente('Otavio Historico Coqueluche'), 'coqueluche', 0, null);
    await db.notification.update({ where: { id: antigo }, data: { knownAt: new Date(Date.now() - 60 * DIA) } });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
  });

  it('sur-1 e tra-1: a dispensa do núcleo grava a unidade e não esconde a sugestão da vigilância municipal', async () => {
    // Bairro Gama: h1 no hospital (há 3 dias), u1 na UBS (há 2 dias), h2 no hospital (há 1 dia), em quarteirões diferentes.
    const h1 = await casoNoQuarteirao('medicaHosp', 'Hugo Lepto Hospital Um', 'leptospirose', 'G1', 3, 4);
    const u1 = await casoNoQuarteirao('medica', 'Ugo Lepto Ubs Um', 'leptospirose', 'G2', 2, 3);
    const h2 = await casoNoQuarteirao('medicaHosp', 'Helio Lepto Hospital Dois', 'leptospirose', 'G3', 1, 2);
    const a = `bairro-7d|BAIRRO:${B['Bairro Gama']}|leptospirose`;
    expect([...assinatura(await sugestoes(), a)!.casos].sort()).toEqual([h1, u1, h2].sort());
    expect([...assinatura(await sugestoes('nucleo'), a)!.casos].sort()).toEqual([h1, h2].sort());
    const motivoNucleo = 'Casos do hospital sem vínculo entre si.';
    const motivoVig = 'Investigado: casos sem fonte comum.';
    await t.http().post('/api/vigilancia/surtos/sugestoes/dispensar').set(auth('nucleo')).send({ assinatura: a, motivo: motivoNucleo }).expect(200);
    // Antes: a sugestão sumia também da vigilância municipal, com o caso da UBS junto.
    expect([...assinatura(await sugestoes(), a)!.casos].sort()).toEqual([h1, u1, h2].sort());
    expect(assinatura(await sugestoes('nucleo'), a)).toBeUndefined();
    expect(await db.outbreakDismissal.findFirstOrThrow({ where: { signature: a } })).toMatchObject({ unitId: U.hosp!.id, dismissedBy: usuario.nucleo });
    // A dispensa da vigilância municipal fica sem unidade e vale para todos.
    await t.http().post('/api/vigilancia/surtos/sugestoes/dispensar').set(auth('vig')).send({ assinatura: a, motivo: motivoVig }).expect(200);
    expect(assinatura(await sugestoes(), a)).toBeUndefined();
    expect((await db.outbreakDismissal.findMany({ where: { signature: a }, orderBy: { dismissedAt: 'asc' } })).map((d) => d.unitId)).toEqual([U.hosp!.id, null]);
    // A trilha guarda o hash do conteúdo: a unidade (escopo) entra nele.
    const auditoria = await db.auditEntry.findMany({ where: { action: 'vigilancia.surto_sugestao_dispensar' }, orderBy: { seq: 'asc' }, select: { userId: true, payloadHash: true } });
    expect(auditoria).toEqual([
      { userId: usuario.nucleo, payloadHash: sha256(canonicalJson({ assinatura: a, casos: 2, motivo: motivoNucleo, unidade: U.hosp!.id })) },
      { userId: usuario.vigilancia, payloadHash: sha256(canonicalJson({ assinatura: a, casos: 3, motivo: motivoVig, unidade: null })) },
    ]);
  });

  it('sur-3: no evento inusitado, a suspeita descartada (notificação ou registro oficial) não conta como caso anterior', async () => {
    // Febre maculosa: única notificação antiga, encerrada como descartada (classificação 2), de 200 dias atrás.
    const fm = await notificar('medica', await novoPaciente('Fabio Maculosa Antigo'), 'febre-maculosa', 0, null);
    await db.notification.update({ where: { id: fm }, data: { status: 'ENCERRADA', finalClass: '2', knownAt: new Date(Date.now() - 200 * DIA), symptomsOnset: new Date(`${diasAtras(201)}T00:00:00Z`) } });
    // Hantavirose: só um registro oficial antigo, DESCARTADO.
    await registro({ grupo: 'hantavirose', agravo: 'A985', notificadoEm: diasAtras(200), situacao: 'DESCARTADO' });
    // Controle: botulismo com caso antigo confirmado (encerrado com classificação 1) continua sem inusitado.
    const bo = await notificar('medica', await novoPaciente('Bruno Botulismo Antigo'), 'botulismo', 0, null);
    await db.notification.update({ where: { id: bo }, data: { status: 'ENCERRADA', finalClass: '1', knownAt: new Date(Date.now() - 200 * DIA) } });
    const novos = {
      'febre-maculosa': await notificar('medica', await novoPaciente('Flavia Maculosa Nova'), 'febre-maculosa', 0, 1),
      hantavirose: await notificar('medica', await novoPaciente('Hilda Hanta Nova'), 'hantavirose', 0, 1),
      botulismo: await notificar('medica', await novoPaciente('Bianca Botulismo Nova'), 'botulismo', 0, 1),
    };
    const s = await sugestoes();
    expect(inusitado(s, 'febre-maculosa')).toMatchObject({ casos: [novos['febre-maculosa']], descricao: 'Primeiro caso do agravo registrado no município: evento inusitado' });
    expect(inusitado(s, 'hantavirose')).toMatchObject({ casos: [novos.hantavirose] });
    expect(inusitado(s, 'botulismo')).toBeUndefined();
  });

  it('sur-4: o caso já em surto é caso anterior; o caso seguinte não vira "primeiro caso"; o núcleo considera os casos das outras unidades', async () => {
    const c1 = await notificar('medica', await novoPaciente('Celso Colera Um'), 'colera', 6, 7);
    const s1 = inusitado(await sugestoes(), 'colera')!;
    expect(s1.casos).toEqual([c1]);
    await criar('vig', {
      ...base,
      assinatura: s1.assinatura,
      casosIndicados: [{ notificationId: c1 }],
      categoria: 'DA_LISTA',
      grupo: 'colera',
      unitId: U.ubs!.id,
      primeirosSintomasEm: diasAtras(7),
      casos: 1,
      localInicial: '1',
    });
    const c2 = await notificar('medica', await novoPaciente('Clara Colera Dois'), 'colera', 0, 1);
    // Antes: o c2 vinha sozinho como "Primeiro caso do agravo registrado no município".
    expect(inusitado(await sugestoes(), 'colera')).toBeUndefined();
    expect((await sugestoes()).some((s) => s.casos.includes(c2))).toBe(false);
    // Difteria: o primeiro caso foi na UBS; o do hospital, depois, não é o primeiro nem para o núcleo do hospital.
    const d1 = await notificar('medica', await novoPaciente('Dora Difteria Ubs'), 'difteria', 5, 6);
    const d2 = await notificar('medicaHosp', await novoPaciente('Davi Difteria Hospital'), 'difteria', 1, 2);
    expect(inusitado(await sugestoes('nucleo'), 'difteria')).toBeUndefined();
    expect(inusitado(await sugestoes(), 'difteria')).toMatchObject({ casos: [d1, d2], descricao: expect.stringContaining('Primeiro caso do agravo registrado') });
  });

  it('sur-5: os casos de surto encerrado ou descartado não voltam como sugestão', async () => {
    const e1 = await casoNoQuarteirao('medica', 'Elsa Hepatite Um', 'hepatites-virais', 'E1', 2, 3);
    const e2 = await casoNoQuarteirao('medica', 'Edu Hepatite Dois', 'hepatites-virais', 'E1', 1, 2);
    const q = `quarteirao-7d|QUARTEIRAO:${Q.E1!.id}|hepatites-virais`;
    expect([...assinatura(await sugestoes(), q)!.casos].sort()).toEqual([e1, e2].sort());
    const descartado = await criar('vig', { ...base, assinatura: q, casosIndicados: [{ notificationId: e1 }, { notificationId: e2 }], categoria: 'DA_LISTA', grupo: 'hepatites-virais', unitId: U.ubs!.id });
    await t.http().post(`/api/vigilancia/surtos/${descartado.id}/descartar`).set(auth('vig')).send({ motivo: 'Não é surto: casos sem fonte comum.' }).expect(200);
    // Antes: com o surto descartado, a mesma assinatura voltava com os mesmos casos.
    expect((await sugestoes()).filter((s) => s.casos.some((c) => [e1, e2].includes(c)))).toEqual([]);
    // Encerrado: idem.
    const z1 = await casoNoQuarteirao('medica', 'Zeca Esquisto Um', 'esquistossomose', 'Z1', 2, 3);
    const z2 = await casoNoQuarteirao('medica', 'Zuleica Esquisto Dois', 'esquistossomose', 'Z1', 1, 2);
    const qz = `quarteirao-7d|QUARTEIRAO:${Q.Z1!.id}|esquistossomose`;
    expect(assinatura(await sugestoes(), qz)).toBeDefined();
    const encerrado = await criar('vig', { ...base, assinatura: qz, casosIndicados: [{ notificationId: z1 }, { notificationId: z2 }], categoria: 'DA_LISTA', grupo: 'esquistossomose', unitId: U.ubs!.id });
    await t
      .http()
      .patch(`/api/vigilancia/surtos/${encerrado.id}`)
      .set(auth('vig'))
      .send({ investigacao: { investigadoEm: hoje() } })
      .expect(200);
    await t.http().post(`/api/vigilancia/surtos/${encerrado.id}/encerrar`).set(auth('vig')).send({ delimitacao: '8', data: hoje() }).expect(200);
    expect((await sugestoes()).filter((s) => s.casos.some((c) => [z1, z2].includes(c)))).toEqual([]);
    // Caso novo no mesmo quarteirão continua gerando sugestão, sem os casos já tratados.
    const z3 = await casoNoQuarteirao('medica', 'Zilda Esquisto Tres', 'esquistossomose', 'Z1', 0, 1);
    const z4 = await casoNoQuarteirao('medica', 'Zenon Esquisto Quatro', 'esquistossomose', 'Z1', 0, 1);
    expect([...assinatura(await sugestoes(), qz)!.casos].sort()).toEqual([z3, z4].sort());
  });

  it('sur-9: o caso sem início dos sintomas conhecido às 21h30 (horário de Brasília) entra nas regras do dia local', async () => {
    // Relógio do serviço: anteontem, 23h no fuso da instituição.
    const d = diasAtras(2);
    const agora = fromZonedParts({ year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)), hour: 23, minute: 0, second: 0 }, TZ);
    const k1 = await casoNoQuarteirao('medica', 'Karla Caxumba Manha', 'caxumba', 'K1', 3, null);
    const k2 = await casoNoQuarteirao('medica', 'Kleber Caxumba Noite', 'caxumba', 'K1', 3, null);
    await db.notification.update({ where: { id: k1 }, data: { knownAt: new Date(agora.getTime() - 12 * H) } });
    // 21h30 em Brasília é 00h30 do dia seguinte em UTC.
    await db.notification.update({ where: { id: k2 }, data: { knownAt: new Date(agora.getTime() - 1.5 * H) } });
    expect(localDateString(new Date(agora.getTime() - 1.5 * H), 'UTC')).not.toBe(d);
    surtos.agora = () => agora;
    try {
      const s = assinatura(await sugestoes(), `quarteirao-7d|QUARTEIRAO:${Q.K1!.id}|caxumba`);
      expect([...(s?.casos ?? [])].sort()).toEqual([k1, k2].sort());
    } finally {
      surtos.agora = () => new Date();
    }
  });

  it('tra-4: a linha de notificação ou registro sigiloso vem mascarada para quem não pode abri-la (planilha, linha do tempo e espelho)', async () => {
    const joana = await novoPaciente('Joana Silva Souza', 'F', '1974-03-10');
    const sifilis = await notificar('medica', joana, 'sifilis', 1, 2);
    const numero = (await db.notification.findUniqueOrThrow({ where: { id: sifilis } })).number;
    const reg = await registro({ grupo: 'sifilis', agravo: 'A539', notificadoEm: diasAtras(3), sensivel: true, unidade: null, cnes: U.ubs!.cnes, nome: 'Rosa Maria Lima', sexo: 'F', nascimento: '1990-05-05' });
    // A vigilância monta um surto de sífilis do hospital com a notificação e o registro sigilosos da UBS.
    const s = await criar('vig', { ...base, casosIndicados: [{ notificationId: sifilis }], categoria: 'DA_LISTA', grupo: 'sifilis', unitId: U.hosp!.id, casos: 3, localInicial: '2' });
    await t.http().post(`/api/vigilancia/surtos/${s.id}/casos`).set(auth('vig')).send({ officialRecordId: reg.id }).expect(201);
    await t
      .http()
      .post(`/api/vigilancia/surtos/${s.id}/casos`)
      .set(auth('vig'))
      .send({ linha: { iniciais: 'XYZ', sexo: 'M', idade: '30 anos' } })
      .expect(201);
    const vig = await detalhe(s.id);
    expect(vig.planilha.map((c) => [c.restrito, c.iniciais, c.sexo])).toEqual([
      [false, 'JSS', 'F'],
      [false, 'RML', 'F'],
      [false, 'XYZ', 'M'],
    ]);
    expect(vig.planilha[0]!.notificacaoNumero).toBe(numero);
    // O núcleo do hospital alcança o surto, mas não abre a notificação nem o registro da UBS.
    await t.http().get(`/api/vigilancia/notificacoes/${sifilis}`).set(auth('nucleo')).expect(403);
    const nuc = await detalhe(s.id, 'nucleo');
    expect(nuc.planilha[0]).toMatchObject({ numero: 1, notificationId: sifilis, restrito: true, iniciais: null, sexo: null, idade: null, notificacaoNumero: null, inicioSintomas: null });
    expect(nuc.planilha[1]).toMatchObject({ numero: 2, officialRecordId: reg.id, restrito: true, iniciais: null, sexo: null, idade: null });
    expect(nuc.planilha[2]).toMatchObject({ numero: 3, restrito: false, iniciais: 'XYZ', idade: '30 anos' });
    const vinculos = nuc.eventos.filter((e) => e.tipo === 'CASO_VINCULADO').map((e) => e.dados);
    expect(vinculos[0]).toMatchObject({ caso: 1, notificacao: 'sob sigilo', restrito: true });
    expect(vinculos[1]).toMatchObject({ caso: 2, registro: 'sob sigilo', restrito: true });
    expect(vinculos[2]).toMatchObject({ caso: 3, manual: true });
    expect(JSON.stringify(nuc.eventos)).not.toContain(numero);
    expect(JSON.stringify(nuc.eventos)).not.toContain(reg.number);
    const espelho = (await t.http().get(`/api/vigilancia/surtos/${s.id}/espelho`).set(auth('nucleo')).expect(200)).body as Detalhe['espelho'];
    expect(espelho.planilha[0]).toEqual({
      NU_CASO: '1',
      NM_CASO: null,
      CS_SEXO: null,
      NU_IDADE_N: null,
      ID_MN_RESI: null,
      NM_BAIRRO: null,
      DT_SIN_PRI: null,
      ID_HOSP: null,
      OBITO: null,
      CLASSI_FIN: null,
      CRITERIO: null,
      DIAG_FINAL: null,
    });
    expect(espelho.planilha[2]).toMatchObject({ NU_CASO: '3', NM_CASO: 'XYZ', NU_IDADE_N: '4030' });
    expect(espelho.avisos.some((a) => a.includes('2 caso(s) da planilha sob sigilo'))).toBe(true);
    // A vigilância vê o número na linha do tempo; a retirada do registro também sai mascarada para o núcleo.
    expect((await detalhe(s.id)).eventos.find((e) => e.tipo === 'CASO_VINCULADO')!.dados).toMatchObject({ notificacao: numero });
    await t.http().delete(`/api/vigilancia/surtos/${s.id}/casos/${vig.planilha[1]!.id}`).set(auth('vig')).expect(200);
    expect((await detalhe(s.id, 'nucleo')).eventos.at(-1)).toMatchObject({ tipo: 'CASO_RETIRADO', dados: { caso: 2, registro: 'sob sigilo', restrito: true } });
    expect((await detalhe(s.id)).eventos.at(-1)).toMatchObject({ tipo: 'CASO_RETIRADO', dados: { caso: 2, registro: reg.number, officialRecordId: reg.id } });
  });

  it('tra-7: envios simultâneos do mesmo registro oficial gravam uma linha só, com a mensagem do registro', async () => {
    const s = await criar('vig', { ...base, categoria: 'FORA_DA_LISTA', cid: 'B08.4', agente: 'Mão-pé-boca na creche', unitId: U.ubs!.id, localInicial: '3' });
    const reg = await registro({ grupo: 'leptospirose', agravo: 'A279', notificadoEm: diasAtras(4), cnes: U.ubs!.cnes, nome: 'Paulo Registro Repetido' });
    const n = await notificar('medica', await novoPaciente('Nina Notificacao Repetida'), 'coqueluche', 1, 2);
    const numero = (await db.notification.findUniqueOrThrow({ where: { id: n } })).number;
    // Todos passam pela preparação antes de qualquer um gravar (a corrida do achado).
    const srv = surtos as unknown as { prepararCaso: (...a: unknown[]) => Promise<unknown> };
    const preparar = srv.prepararCaso.bind(surtos);
    const espera = vi.spyOn(srv, 'prepararCaso').mockImplementation(async (...a: unknown[]) => {
      const r = await preparar(...a);
      await new Promise((ok) => setTimeout(ok, 400));
      return r;
    });
    try {
      for (const [corpo, mensagem] of [
        [{ officialRecordId: reg.id }, `O registro ${reg.number} já está na planilha deste surto`],
        [{ notificationId: n }, `A notificação ${numero} já está na planilha deste surto`],
      ] as const) {
        const r = await Promise.all([0, 1, 2].map(() => t.http().post(`/api/vigilancia/surtos/${s.id}/casos`).set(auth('vig')).send(corpo)));
        expect(r.map((x) => x.status).sort()).toEqual([201, 409, 409]);
        expect(r.filter((x) => x.status === 409).map((x) => x.body.message)).toEqual([mensagem, mensagem]);
      }
    } finally {
      espera.mockRestore();
    }
    expect(await db.outbreakCase.count({ where: { outbreakId: s.id, officialRecordId: reg.id } })).toBe(1);
    expect(await db.outbreakCase.count({ where: { outbreakId: s.id, notificationId: n } })).toBe(1);
    expect((await detalhe(s.id)).planilha.map((c) => c.numero)).toEqual([1, 2]);
  });

  it('K7 e K8: bloco DTA conferido pela regra do shared e datas do espelho em dd/mm/aaaa', async () => {
    const s = await criar('vig', { ...base, categoria: 'DTA', cid: 'A05.9', agente: 'Festa da escola', unitId: U.ubs!.id, casos: 12, localInicial: '3' });
    const patch = (corpo: Record<string, unknown>, status: number) => t.http().patch(`/api/vigilancia/surtos/${s.id}`).set(auth('vig')).send(corpo).expect(status);
    // Antes: o texto no lugar do número e a data futura eram aceitos.
    expect((await patch({ dta: { NU_ENTR: 'quarenta' } }, 400)).body).toMatchObject({ code: 'SURTO_INVALIDO', details: { erros: ['DTA, Nº de entrevistados: número inteiro.'] } });
    const amanha = localDateString(new Date(Date.now() + DIA), TZ);
    expect((await patch({ dta: { DT_ENCERRA: amanha } }, 400)).body.details.erros).toEqual(['DTA, Data de encerramento (DTA): data válida e não futura.']);
    expect((await patch({ dta: { CRITERIO: '7' } }, 400)).body.details.erros).toEqual(['DTA, Critério de confirmação: código de 1 a 5.']);
    await patch({ investigacao: { investigadoEm: hoje(), veiculo: '1' }, dta: { NU_ENTR: 40, DT_ENCERRA: hoje(), DS_ALICAUS: 'Salada de maionese', DT_OUTRA: diasAtras(1) } }, 200);
    const e = (await t.http().get(`/api/vigilancia/surtos/${s.id}/espelho`).set(auth('vig')).expect(200)).body as Detalhe['espelho'];
    expect(Object.fromEntries(e.dta.map((d) => [d.variavel, [d.rotulo, d.valor]]))).toEqual({
      NU_ENTR: ['Nº de entrevistados', '40'],
      DT_ENCERRA: ['Data de encerramento (DTA)', ddmm(hoje())],
      DS_ALICAUS: ['Alimento causador', 'Salada de maionese'],
      DT_OUTRA: ['DT_OUTRA', ddmm(diasAtras(1))],
    });
    expect(e.campos.find((c) => c.variavel === 'DT_INVEST')!.valor).toBe(ddmm(hoje()));
    // Idade da linha manual pela regra do shared.
    expect(
      (
        await t
          .http()
          .post(`/api/vigilancia/surtos/${s.id}/casos`)
          .set(auth('vig'))
          .send({ linha: { idade: '13 meses' } })
          .expect(400)
      ).body.code,
    ).toBe('IDADE_INVALIDA');
    expect(
      (
        (
          await t
            .http()
            .post(`/api/vigilancia/surtos/${s.id}/casos`)
            .set(auth('vig'))
            .send({ linha: { idade: '11 mês' } })
            .expect(201)
        ).body as { caso: Caso }
      ).caso.idade,
    ).toBe('11 meses');
  });
});
