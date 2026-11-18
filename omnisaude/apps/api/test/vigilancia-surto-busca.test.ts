import { canonicalJson, demoFixtures, sha256 } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Surto (VIG-1c, K10): busca das notificações candidatas e dos registros oficiais para a planilha, com
 * `vigilancia.surto`. Grupo, período e texto (além das notificações mais recentes do painel); alcance do núcleo e sigilo;
 * a busca por texto e a lista de registros oficiais ficam na trilha de auditoria.
 */
const enabled = await pgAvailable();
const DIA = 24 * 3_600_000;
const TZ = 'America/Sao_Paulo';
const diasAtras = (n: number) => localDateString(new Date(Date.now() - n * DIA), TZ);

type Candidata = { id: string; numero: string; status: string; grupo: string; unidade: { id: string; nome: string }; paciente: string; sigilosa: boolean; emSurtos: string[] };
type Registro = {
  id: string;
  numero: string;
  sistema: string;
  unidade: { id: string | null; cnes: string | null; nome: string | null };
  paciente: { nome: string | null } | null;
  sigiloso: boolean;
  agravoNome: string | null;
  emSurtos: string[];
};

describe.runIf(enabled)('Vigilância: busca de notificações e registros para a planilha do surto (K10)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  const tk: Record<string, string> = {};
  const U: Record<string, { id: string; cnes: string }> = {};
  const usuario: Record<string, string> = {};
  const n: Record<string, string> = {};
  const r: Record<string, { id: string; number: string }> = {};
  const cpf: Record<string, string> = {};
  let seq = 0;
  let nReg = 0;
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const candidatas = async (k: string, q: Record<string, string>, status = 200) =>
    (await t.http().get('/api/vigilancia/surtos/candidatas').query(q).set(auth(k)).expect(status)).body as { itens: Candidata[]; limitado: boolean };
  const registros = async (k: string, q: Record<string, string>, status = 200) =>
    (await t.http().get('/api/vigilancia/surtos/registros').query(q).set(auth(k)).expect(status)).body as { itens: Registro[]; limitado: boolean };
  const ids = (l: { id: string }[]) => l.map((x) => x.id).sort();
  const novoPaciente = async (nome: string, sex: 'M' | 'F' = 'M') => {
    seq++;
    cpf[nome] = completeCpf(String(273000700 + seq));
    const body = {
      name: nome,
      birthDate: `${1970 + seq}-0${1 + (seq % 9)}-1${seq % 8}`,
      sex,
      cpf: cpf[nome],
      cns: cnsFromBase(String(27300000700 + seq)),
      motherName: `Mae de ${nome}`,
      phone: '(11) 97777-2703',
      address: { cep: '01001000', street: 'Rua da Busca', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
      confirmNotDuplicate: true,
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  const notificar = async (k: string, nome: string, conditionKey: string, conhecidoHaDias: number, sex: 'M' | 'F' = 'M') =>
    (
      (
        await t
          .http()
          .post('/api/vigilancia/notificacoes')
          .set(auth(k))
          .send({ patientId: await novoPaciente(nome, sex), conditionKey, knownAt: new Date(Date.now() - Math.min(conhecidoHaDias, 1) * DIA).toISOString(), symptomsOnset: diasAtras(Math.min(conhecidoHaDias, 1) + 1) })
          .expect(201)
      ).body as { id: string }
    ).id;
  const registro = async (o: {
    grupo: string;
    agravo: string;
    tipo?: 'INDIVIDUAL' | 'NEGATIVA';
    excluido?: boolean;
    sensivel?: boolean;
    unidade?: string | null;
    cnes?: string | null;
    nome: string;
    notificadoEm: string;
  }) => {
    nReg++;
    const imp = await db.officialImport.findFirstOrThrow({ where: { fileName: 'c27c1-busca.zip' } });
    return db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: o.tipo ?? 'INDIVIDUAL',
        naturalKey: `c27c1-busca-${nReg}`,
        number: String(8_200_000 + nReg),
        notifiedOn: new Date(`${o.notificadoEm}T00:00:00Z`),
        municipalityIbge: '355030',
        unitCnes: o.cnes ?? null,
        unitId: o.unidade ?? null,
        agravo: o.agravo,
        groupKey: o.grupo,
        situation: 'CONFIRMADO',
        excluded: o.excluido ?? false,
        sensitive: o.sensivel ?? false,
        patientName: o.nome,
        patientNameNorm: o.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
        sex: 'F',
        contentHash: '0'.repeat(64),
        firstImportId: imp.id,
        lastImportId: imp.id,
        lastSeenAt: new Date(),
      },
      select: { id: true, number: true },
    });
  };
  const auditadas = (action: string) => db.auditEntry.findMany({ where: { action }, orderBy: { seq: 'asc' }, select: { userId: true, payloadHash: true } });

  beforeAll(async () => {
    t = await startTestApp('vigsurtobusca');
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
    await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'c27c1-busca.zip', sha256: 'b'.repeat(64), sizeBytes: 1, createdBy: usuario.vigilancia! } });
    // Leptospirose: uma antiga (200 dias) e uma recente na UBS, uma no hospital e uma descartada.
    n.antiga = await notificar('medica', 'Lucas Antigo Lepto', 'leptospirose', 200);
    await db.notification.update({ where: { id: n.antiga }, data: { knownAt: new Date(Date.now() - 200 * DIA), symptomsOnset: new Date(`${diasAtras(201)}T00:00:00Z`) } });
    n.recente = await notificar('medica', 'Larissa Nova Lepto', 'leptospirose', 1, 'F');
    n.hosp = await notificar('medicaHosp', 'Heitor Hospital Lepto', 'leptospirose', 1);
    n.descartada = await notificar('medica', 'Lauro Descartado Lepto', 'leptospirose', 1);
    await t.http().post(`/api/vigilancia/notificacoes/${n.descartada}/descartar`).set(auth('vig')).send({ reason: 'Não preenche a definição de caso.' }).expect(200);
    // Sífilis (sigilosa): uma na UBS e uma no hospital.
    n.sifilisUbs = await notificar('medica', 'Sara Sigilo Ubs', 'sifilis', 1, 'F');
    n.sifilisHosp = await notificar('medicaHosp', 'Sofia Sigilo Hospital', 'sifilis', 1, 'F');
    // Registros oficiais: da UBS (pela unidade), do hospital (só pelo CNES), sigiloso da UBS, excluído e negativa.
    r.ubs = await registro({ grupo: 'leptospirose', agravo: 'A279', unidade: U.ubs!.id, cnes: U.ubs!.cnes, nome: 'Rita Registro Ubs', notificadoEm: diasAtras(10) });
    r.hosp = await registro({ grupo: 'leptospirose', agravo: 'A279', cnes: U.hosp!.cnes, nome: 'Rui Registro Hospital', notificadoEm: diasAtras(5) });
    r.sigiloso = await registro({ grupo: 'sifilis', agravo: 'A539', unidade: U.ubs!.id, cnes: U.ubs!.cnes, sensivel: true, nome: 'Rosa Sigilo Registro', notificadoEm: diasAtras(3) });
    r.excluido = await registro({ grupo: 'leptospirose', agravo: 'A279', cnes: U.ubs!.cnes, excluido: true, nome: 'Raul Excluido', notificadoEm: diasAtras(4) });
    r.negativa = await registro({ grupo: 'leptospirose', agravo: 'A279', cnes: U.ubs!.cnes, tipo: 'NEGATIVA', nome: 'Renan Negativa', notificadoEm: diasAtras(4) });
  });

  afterAll(async () => {
    await t?.close();
  });

  it('notificações por grupo e período (inclusive as antigas), sem as descartadas; quem não tem a permissão de surto recebe 403', async () => {
    expect(ids((await candidatas('vig', { grupo: 'leptospirose' })).itens)).toEqual([n.antiga, n.recente, n.hosp].sort());
    // Período do conhecimento: as dos últimos 30 dias; só a de 200 dias atrás.
    expect(ids((await candidatas('vig', { grupo: 'leptospirose', de: diasAtras(30), ate: diasAtras(0) })).itens)).toEqual([n.recente, n.hosp].sort());
    expect(ids((await candidatas('vig', { grupo: 'leptospirose', de: diasAtras(210), ate: diasAtras(190) })).itens)).toEqual([n.antiga]);
    const r = await candidatas('vig', { grupo: 'leptospirose' });
    expect(r.limitado).toBe(false);
    expect(r.itens.find((i) => i.id === n.recente)).toMatchObject({ grupo: 'leptospirose', unidade: { id: U.ubs!.id, nome: 'UBS Centro' }, paciente: 'Larissa Nova Lepto', sigilosa: false, emSurtos: [] });
    await candidatas('medica', { grupo: 'leptospirose' }, 403);
    await registros('medica', { grupo: 'leptospirose' }, 403);
    // Consulta inválida: texto de 1 letra e período invertido.
    await candidatas('vig', { busca: 'a' }, 400);
    await candidatas('vig', { de: diasAtras(1), ate: diasAtras(5) }, 400);
  });

  it('busca por texto (nome, número e CPF), auditada com o filtro', async () => {
    const antes = (await auditadas('vigilancia.surto_busca_notificacoes')).length;
    expect(ids((await candidatas('vig', { busca: 'antigo lepto' })).itens)).toEqual([n.antiga]);
    const numero = (await db.notification.findUniqueOrThrow({ where: { id: n.recente } })).number;
    expect(ids((await candidatas('vig', { busca: numero })).itens)).toEqual([n.recente]);
    expect(ids((await candidatas('vig', { busca: cpf['Heitor Hospital Lepto']! })).itens)).toEqual([n.hosp]);
    // Busca sem resultado também fica registrada (a busca nominal em si é o ato auditado).
    expect((await candidatas('vig', { busca: 'ninguem com esse nome' })).itens).toEqual([]);
    const trilha = await auditadas('vigilancia.surto_busca_notificacoes');
    expect(trilha).toHaveLength(antes + 4);
    expect(trilha[antes]).toEqual({
      userId: usuario.vigilancia,
      payloadHash: sha256(canonicalJson({ filtro: { grupo: null, de: null, ate: null, busca: 'antigo lepto', surtoId: null }, linhas: 1, sigilosas: [] })),
    });
    // Lista sem texto e sem sigilosa não entra na trilha.
    await candidatas('vig', { grupo: 'leptospirose' });
    expect(await auditadas('vigilancia.surto_busca_notificacoes')).toHaveLength(antes + 4);
  });

  it('alcance do núcleo e sigilo: o núcleo vê só a unidade dele; a sigilosa só para quem a abre, auditada', async () => {
    expect(ids((await candidatas('nucleo', { grupo: 'leptospirose' })).itens)).toEqual([n.hosp]);
    expect(ids((await candidatas('nucleo', { busca: 'antigo lepto' })).itens)).toEqual([]);
    expect(ids((await candidatas('nucleo', { grupo: 'sifilis' })).itens)).toEqual([n.sifilisHosp]);
    const antes = (await auditadas('vigilancia.surto_busca_notificacoes')).length;
    const vig = await candidatas('vig', { grupo: 'sifilis' });
    expect(ids(vig.itens)).toEqual([n.sifilisUbs, n.sifilisHosp].sort());
    expect(vig.itens.every((i) => i.sigilosa && i.paciente)).toBe(true);
    const trilha = await auditadas('vigilancia.surto_busca_notificacoes');
    expect(trilha).toHaveLength(antes + 1);
    expect(trilha.at(-1)!.payloadHash).toBe(sha256(canonicalJson({ filtro: { grupo: 'sifilis', de: null, ate: null, busca: null, surtoId: null }, linhas: 2, sigilosas: vig.itens.map((i) => i.id) })));
  });

  it('com o surto: as que já estão na planilha ficam de fora; as que estão em surto aberto dizem em qual; o núcleo não abre surto de outra unidade', async () => {
    const s = (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('vig'))
        .send({
          casosIndicados: [{ notificationId: n.recente }],
          categoria: 'DA_LISTA',
          grupo: 'leptospirose',
          notificadoEm: diasAtras(0),
          conhecidoEm: new Date(Date.now() - 3_600_000).toISOString(),
          unitId: U.ubs!.id,
          primeirosSintomasEm: diasAtras(3),
          casos: 2,
          localInicial: '8',
        })
        .expect(201)
    ).body as { id: string; numero: string };
    await t.http().post(`/api/vigilancia/surtos/${s.id}/casos`).set(auth('vig')).send({ officialRecordId: r.ubs!.id }).expect(201);
    expect(ids((await candidatas('vig', { grupo: 'leptospirose', surtoId: s.id })).itens)).toEqual([n.antiga, n.hosp].sort());
    expect((await candidatas('vig', { grupo: 'leptospirose' })).itens.find((i) => i.id === n.recente)!.emSurtos).toEqual([s.numero]);
    expect(ids((await registros('vig', { grupo: 'leptospirose', surtoId: s.id })).itens)).toEqual([r.hosp!.id]);
    expect((await registros('vig', { grupo: 'leptospirose' })).itens.find((i) => i.id === r.ubs!.id)!.emSurtos).toEqual([s.numero]);
    await candidatas('nucleo', { surtoId: s.id }, 403);
    await registros('nucleo', { surtoId: s.id }, 403);
  });

  it('registros oficiais: individuais e não excluídos, por grupo e texto; o núcleo vê os da unidade (id ou CNES); lista auditada', async () => {
    const antes = (await auditadas('vigilancia.surto_busca_registros')).length;
    const todos = await registros('vig', { grupo: 'leptospirose' });
    expect(ids(todos.itens)).toEqual([r.ubs!.id, r.hosp!.id].sort());
    expect(todos.itens.find((i) => i.id === r.hosp!.id)).toMatchObject({
      sistema: 'SINAN_NET',
      numero: r.hosp!.number,
      unidade: { id: null, cnes: U.hosp!.cnes },
      paciente: { nome: 'Rui Registro Hospital' },
      sigiloso: false,
    });
    expect(todos.itens[0]!.agravoNome).toBeTruthy();
    expect(ids((await registros('vig', { busca: 'rita registro' })).itens)).toEqual([r.ubs!.id]);
    expect(ids((await registros('vig', { busca: r.hosp!.number })).itens)).toEqual([r.hosp!.id]);
    expect(ids((await registros('vig', { grupo: 'leptospirose', de: diasAtras(7), ate: diasAtras(0) })).itens)).toEqual([r.hosp!.id]);
    // Núcleo do hospital: só o registro do CNES dele; o sigiloso da UBS não aparece.
    expect(ids((await registros('nucleo', { grupo: 'leptospirose' })).itens)).toEqual([r.hosp!.id]);
    expect((await registros('nucleo', { grupo: 'sifilis' })).itens).toEqual([]);
    const sig = await registros('vig', { grupo: 'sifilis' });
    expect(sig.itens).toMatchObject([{ id: r.sigiloso!.id, sigiloso: true, paciente: { nome: 'Rosa Sigilo Registro' } }]);
    const trilha = await auditadas('vigilancia.surto_busca_registros');
    // Uma entrada por consulta com linhas (a do núcleo sem registro de sífilis e sem texto não entra).
    expect(trilha).toHaveLength(antes + 6);
    expect(trilha.at(-1)!.payloadHash).toBe(sha256(canonicalJson({ filtro: { grupo: 'sifilis', de: null, ate: null, busca: null, surtoId: null }, linhas: 1, sigilosos: [r.sigiloso!.id] })));
    expect(trilha.at(-2)!.userId).toBe(usuario.nucleo);
  });
});
