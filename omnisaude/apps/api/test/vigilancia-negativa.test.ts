import { inflateSync } from 'node:zlib';
import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, completeCpf, deslocarSemana, intervaloDaSemana, semanaEpidemiologica } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { NegativaService } from '../src/modules/vigilancia/negativa.service';
import { NotificacaoService } from '../src/modules/vigilancia/notificacao.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();
const H = 3_600_000;
const DIA = 24 * H;
const TZ = 'America/Sao_Paulo';

// Relógio do serviço fixo (nenhum teste depende da data do relógio). SE 202624 = 14 a 20/06/2026.
// Prazo padrão: segunda-feira às 14h (horário de Brasília) da semana seguinte; o da SE 202623 é 15/06/2026 17:00 UTC.
const QUARTA = new Date('2026-06-17T15:00:00Z');
const SEGUNDA_1359 = new Date('2026-06-15T16:59:00Z');
const SEGUNDA_1401 = new Date('2026-06-15T17:01:00Z');

/** Texto das linhas desenhadas no PDF (pdf-lib: fontes padrão, texto em hexadecimal WinAnsi, conteúdo comprimido). */
function textoDoPdf(pdf: Buffer): string {
  const bin = pdf.toString('latin1');
  const partes: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const ini = m.index + m[0].length;
    const fim = bin.indexOf('endstream', ini);
    if (fim < 0) break;
    const bruto = Buffer.from(bin.slice(ini, fim).replace(/\r?\n$/, ''), 'latin1');
    let conteudo: string;
    try {
      conteudo = inflateSync(bruto).toString('latin1');
    } catch {
      conteudo = bruto.toString('latin1');
    }
    for (const t of conteudo.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) partes.push(Buffer.from(t[1]!, 'hex').toString('latin1'));
    for (const t of conteudo.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) partes.push(t[1]!);
  }
  return partes.join('\n');
}

type Atesto = {
  id: string;
  status: string;
  atrasado: boolean;
  emNome: boolean;
  motivoEmNome: string | null;
  declaracao: string;
  semana: string;
  atestadoPor: string;
  funcao: string | null;
  causa: { tipo: string; id: string } | null;
  registroOficialId: string | null;
};
type Celula = { semana: string; situacao: string; fontes: { notificacoes: number; surtos: number; registrosOficiais: number; atesto: { id: string; atrasado: boolean } | null; negativaSinan: boolean } };
type Grade = {
  colunas: { semana: string; fechada: boolean; prazo: string }[];
  linhas: { unidade: { id: string; nome: string }; celulas: Celula[] }[];
  analise: {
    silenciosas: { unitId: string; semanasSeguidas: number }[];
    soNegativas: { unitId: string; semanas: number }[];
    percentualPorSemana: { semana: number; comInformacao: number; notificantes: number; percentual: number | null }[];
    regularidadeMunicipal: { semanasSemInformacao: number; irregular: boolean };
  };
  metaPercentual: number;
  atestadoSemSinan: { unidade: { id: string }; semana: string }[];
  sinanSemAtesto: { unidade: { id: string }; semana: string }[];
  avisos: string[];
};

describe.runIf(enabled)('Vigilância: notificação negativa semanal (VIG-1c)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let negativas: NegativaService;
  const tk: Record<string, string> = {};
  const U: Record<string, { id: string; cnes: string }> = {};
  const usuario: Record<string, string> = {};
  const atestos: Record<string, Atesto> = {};
  let seq = 0;
  let importacaoId = '';
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const relogio = (d: Date) => {
    negativas.agora = () => d;
  };
  const atestar = (k: string, corpo: Record<string, unknown>, status: number) => t.http().post('/api/vigilancia/negativas').set(auth(k)).send(corpo).expect(status);
  const grade = async (q: string, k = 'gestora') => (await t.http().get(`/api/vigilancia/negativas/grade?${q}`).set(auth(k)).expect(200)).body as Grade;
  const celula = (g: Grade, unidade: string, semana: string) => g.linhas.find((l) => l.unidade.id === U[unidade]!.id)!.celulas.find((c) => c.semana === semana)!;
  const tarefa = async () => {
    const tenants = t.app.get(TenantsService);
    tenants.connections.invalidate(t.slug);
    const tenant = await tenants.resolve(t.slug);
    return t.app.get(NotificacaoService).tarefa({ tenant, db: await tenants.client(tenant.id) });
  };
  const novoPaciente = async (sex: 'M' | 'F' = 'M') => {
    seq++;
    const body = {
      name: `Paciente Negativa ${['Abel', 'Bento', 'Caio', 'Davi', 'Enzo', 'Fabio', 'Gael', 'Hugo', 'Igor', 'Joel'][seq % 10]} ${seq} Teste`,
      birthDate: `${1970 + seq}-0${1 + (seq % 9)}-1${seq % 10}`,
      confirmNotDuplicate: true,
      sex,
      cpf: completeCpf(String(271000500 + seq)),
      cns: cnsFromBase(String(27100000500 + seq)),
      motherName: `Mae Negativa ${seq}`,
      phone: '(11) 97777-2700',
      address: { cep: '01001000', street: 'Rua da Negativa', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
    };
    return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
  };
  /** Notificação manual de coqueluche (UBS Centro), ajustada no banco para a unidade, situação e semana do teste. */
  const novaNotificacao = async (dados: { unitId?: string; status?: 'RASCUNHO' | 'NOTIFICADA' | 'ENCERRADA'; epiWeekNotified?: string | null; knownAt?: Date; notifiedAt?: Date | null }) => {
    const p = await novoPaciente();
    const n = (await t.http().post('/api/vigilancia/notificacoes').set(auth('medica')).send({ patientId: p, conditionKey: 'coqueluche' }).expect(201)).body as { id: string };
    const r = await db.notification.update({ where: { id: n.id }, data: dados, select: { id: true, number: true } });
    return { id: r.id, numero: r.number };
  };
  const registroOficial = (p: { tipo: 'INDIVIDUAL' | 'NEGATIVA' | 'SURTO'; unidade: string; semana: string; numero: string; excluido?: boolean }) => {
    const { fim } = intervaloDaSemana(Number(p.semana.slice(0, 4)), Number(p.semana.slice(4)));
    return db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: p.tipo,
        naturalKey: `${p.numero}|${fim}|355030|${p.tipo === 'INDIVIDUAL' ? 'A379' : U[p.unidade]!.cnes}`,
        number: p.numero,
        notifiedOn: new Date(`${fim}T00:00:00Z`),
        epiWeekNotified: p.semana,
        municipalityIbge: '355030',
        unitCnes: U[p.unidade]!.cnes,
        agravo: p.tipo === 'INDIVIDUAL' ? 'A379' : null,
        groupKey: p.tipo === 'INDIVIDUAL' ? 'coqueluche' : null,
        situation: 'EM_INVESTIGACAO',
        excluded: p.excluido ?? false,
        contentHash: 'c'.repeat(64),
        firstImportId: importacaoId,
        lastImportId: importacaoId,
        lastSeenAt: new Date(),
      },
      select: { id: true, number: true },
    });
  };
  const surtoNoBanco = (unidade: string, dia: string, numero: string) =>
    db.outbreak.create({
      data: {
        year: 2026,
        seq: Number(numero.slice(5)),
        number: numero,
        category: 'DTA',
        notifiedOn: new Date(`${dia}T00:00:00Z`),
        knownAt: new Date(`${dia}T12:00:00Z`),
        dueAt: new Date(`${dia}T12:00:00Z`),
        unitId: U[unidade]!.id,
        notifierId: usuario.vigilancia!,
        firstSymptomsOn: new Date(`${dia}T00:00:00Z`),
        casesCount: 4,
        initialPlace: '3',
        createdBy: usuario.vigilancia!,
      },
      select: { id: true, number: true },
    });

  beforeAll(async () => {
    t = await startTestApp('vignegativa');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.enfermeiro = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    tk.gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    tk.cardio = await t.login('cardiologista', 'Policlínica Municipal', 'MEDICO');
    tk.nir = await t.login('nir', 'Policlínica Municipal', 'NIR');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    negativas = t.app.get(NegativaService);
    for (const u of demoFixtures.UNITS) U[u.key] = { id: (await db.unit.findUniqueOrThrow({ where: { cnes: u.cnes } })).id, cnes: u.cnes };
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
    // Banco do teste: começa sem o que a semeadura da demonstração possa ter gravado nestas tabelas.
    for (const tabela of [
      'negative_reports',
      'notifying_unit_responsibles',
      'notifying_units',
      'outbreak_cases',
      'outbreak_events',
      'outbreak_dismissals',
      'outbreaks',
      'official_record_rejections',
      'official_records',
      'official_imports',
    ])
      await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
    importacaoId = (
      await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'teste-negativa.dbf', sha256: 'd'.repeat(64), sizeBytes: 1, createdBy: usuario.vigilancia!, appliedAt: new Date() } })
    ).id;
    relogio(QUARTA);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('unidades notificantes: abre o período, recusa o duplicado e a sobreposição, lista as sem configuração', async () => {
    for (const [k, desde] of [
      ['ubs', '2026-01-01'],
      ['ubs2', '2026-01-01'],
      ['upa', '2026-01-01'],
      ['hosp', '2026-01-01'],
      ['ceo', '2026-01-01'],
      ['poli', '2026-05-01'],
    ] as const)
      await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: U[k]!.id, desde }).expect(201);
    const dup = await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: U.ubs!.id, desde: '2026-02-01' }).expect(409);
    expect(dup.body.message).toContain('01/01/2026');
    // Encerra e reabre: o novo período não começa antes do fim do anterior.
    const enc = (await t.http().post(`/api/vigilancia/unidades-notificantes/${U.ceo!.id}/encerrar`).set(auth('vig')).send({ ate: '2026-02-28', motivo: 'Reforma do prédio' }).expect(200)).body;
    expect(enc).toMatchObject({ periodoAtual: null, periodos: [{ desde: '2026-01-01', ate: '2026-02-28', motivoFim: 'Reforma do prédio' }] });
    expect((await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: U.ceo!.id, desde: '2026-02-15' }).expect(422)).body.code).toBe('PERIODO_SOBREPOSTO');
    const reaberta = (await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: U.ceo!.id, desde: '2026-03-01' }).expect(201)).body;
    expect(reaberta.periodoAtual).toMatchObject({ desde: '2026-03-01', ate: null });
    expect(reaberta.periodos).toHaveLength(2);
    // Unidade nova que atende, sem período: "sem configuração"; farmácia central, almoxarifado e vigilância, não.
    await db.unit.create({ data: { cnes: '9000990', name: 'CAPS Teste Negativa', type: 'CAPS', ibgeCode: '3550308' } });
    const lista = (await t.http().get('/api/vigilancia/unidades-notificantes').set(auth('vig')).expect(200)).body as {
      unidade: { nome: string; cnes: string };
      semConfiguracao: boolean;
      periodoAtual: { desde: string } | null;
    }[];
    expect(lista.find((u) => u.unidade.cnes === '9000990')).toMatchObject({ semConfiguracao: true, periodoAtual: null });
    expect(lista.find((u) => u.unidade.cnes === U.fc!.cnes)).toMatchObject({ semConfiguracao: false });
    expect(lista.find((u) => u.unidade.cnes === U.ubs!.cnes)).toMatchObject({ semConfiguracao: false, periodoAtual: { desde: '2026-01-01' } });
    // A configuração é da vigilância (o gestor lê a grade, não configura).
    await t.http().get('/api/vigilancia/unidades-notificantes').set(auth('gestora')).expect(403);
  });

  it('responsáveis: titular e substituto com lotação ativa, um titular por unidade, busca de lotados', async () => {
    const designar = (unidade: string, userKey: string, tipo: string, status: number) =>
      t.http().post(`/api/vigilancia/unidades-notificantes/${U[unidade]!.id}/responsaveis`).set(auth('vig')).send({ userId: usuario[userKey], tipo, desde: '2026-01-01' }).expect(status);
    const r = (await designar('ubs', 'enfermeiro', 'TITULAR', 201)).body;
    expect(r.responsaveis).toMatchObject([{ nome: 'Bruno Almeida Enfermeiro', tipo: 'TITULAR', ate: null, designadoPor: 'Vera Lúcia Vigilância Epidemiológica' }]);
    await designar('ubs', 'medica', 'SUBSTITUTO', 201);
    // Sem lotação na UBS Centro (o cardiologista é só da policlínica).
    expect((await designar('ubs', 'cardiologista', 'SUBSTITUTO', 422)).body.code).toBe('SEM_LOTACAO');
    // A unidade já tem titular; e quem já é responsável não é designado de novo.
    expect((await designar('ubs', 'gestora', 'TITULAR', 409)).body.message).toContain('Bruno Almeida Enfermeiro');
    await designar('ubs', 'enfermeiro', 'SUBSTITUTO', 409);
    await designar('upa', 'enfermeiro', 'TITULAR', 201);
    await designar('hosp', 'enfermeiro', 'TITULAR', 201);
    await designar('poli', 'nir', 'TITULAR', 201);
    // Unidade que não é notificante (o CAPS novo): primeiro o período.
    await db.userAssignment.create({ data: { userId: usuario.social!, unitId: (await db.unit.findUniqueOrThrow({ where: { cnes: '9000990' } })).id, role: 'SERVICO_SOCIAL', cbo: '251605' } });
    expect(
      (
        await t
          .http()
          .post(`/api/vigilancia/unidades-notificantes/${(await db.unit.findUniqueOrThrow({ where: { cnes: '9000990' } })).id}/responsaveis`)
          .set(auth('vig'))
          .send({ userId: usuario.social, tipo: 'TITULAR', desde: '2026-01-01' })
          .expect(422)
      ).body.code,
    ).toBe('NAO_NOTIFICANTE');
    const lotados = (await t.http().get(`/api/vigilancia/unidades-notificantes/${U.ubs!.id}/lotados?busca=almeida`).set(auth('vig')).expect(200)).body;
    expect(lotados).toEqual([{ userId: usuario.enfermeiro, nome: 'Bruno Almeida Enfermeiro', papeis: ['ENFERMAGEM'], cbo: '223505', responsavel: 'TITULAR' }]);
    const porCpf = (
      await t
        .http()
        .get(`/api/vigilancia/unidades-notificantes/${U.ubs!.id}/lotados?busca=${demoFixtures.STAFF.find((s) => s.key === 'medica')!.cpf}`)
        .set(auth('vig'))
        .expect(200)
    ).body;
    expect(porCpf).toMatchObject([{ nome: 'Carla Menezes Médica', responsavel: 'SUBSTITUTO' }]);
    await t.http().get(`/api/vigilancia/unidades-notificantes/${U.ubs!.id}/lotados`).set(auth('gestora')).expect(403);
  });

  it('minhas: as semanas fechadas de cada unidade, com o prazo no fuso da instituição e o texto do atesto à vista', async () => {
    relogio(SEGUNDA_1359);
    const r = (await t.http().get('/api/vigilancia/negativas/minhas').set(auth('enfermeiro')).expect(200)).body as {
      unidades: { unidade: { id: string; nome: string }; tipo: string; semanas: { semana: string; situacao: string; prazo: string; prazoPassou: boolean; podeAtestar: boolean; motivo: string | null; texto: string }[] }[];
    };
    expect(r.unidades.map((u) => u.unidade.nome).sort()).toEqual(['Hospital Municipal São Lucas', 'UBS Centro', 'UPA 24h Norte']);
    const ubs = r.unidades.find((u) => u.unidade.id === U.ubs!.id)!;
    expect(ubs.tipo).toBe('TITULAR');
    expect(ubs.semanas).toHaveLength(8);
    expect(ubs.semanas[0]).toMatchObject({ semana: '202623', situacao: 'AGUARDANDO', prazo: '2026-06-15T17:00:00.000Z', prazoPassou: false, podeAtestar: true, motivo: null });
    expect(ubs.semanas[0]!.texto).toContain('Eu, Bruno Almeida Enfermeiro, Enfermagem / Triagem, CBO 223505, declaro, como responsável pela notificação da unidade UBS Centro (CNES 9000011)');
    expect(ubs.semanas[0]!.texto).toContain('semana epidemiológica 23/2026 (07/06 a 13/06/2026)');
    expect(ubs.semanas[1]).toMatchObject({ semana: '202622', situacao: 'SEM_INFORMACAO', prazoPassou: true, podeAtestar: true });
    expect(ubs.semanas[7]!.semana).toBe('202616');
    // O gestor tem a tela, mas não é responsável de nenhuma unidade.
    expect((await t.http().get('/api/vigilancia/negativas/minhas').set(auth('gestora')).expect(200)).body.unidades).toEqual([]);
    await t.http().get('/api/vigilancia/negativas/minhas').set(auth('recepcao')).expect(403);
  });

  it('atesto no prazo e fora dele (prazo no fuso da instituição); o segundo atesto da semana é 409', async () => {
    relogio(SEGUNDA_1359);
    const texto = (await t.http().get('/api/vigilancia/negativas/minhas').set(auth('enfermeiro')).expect(200)).body.unidades.find((u: { unidade: { id: string } }) => u.unidade.id === U.ubs!.id).semanas[0].texto;
    // 13h59 em Brasília (16h59 UTC): ainda no prazo; lido em UTC, já teria passado das 14h.
    const a = (await atestar('enfermeiro', { unitId: U.ubs!.id, semana: '202623' }, 201)).body as Atesto;
    expect(a).toMatchObject({ status: 'ATESTADA', atrasado: false, emNome: false, semana: '202623', atestadoPor: 'Bruno Almeida Enfermeiro', causa: null });
    expect(a.funcao).toBe('Enfermagem / Triagem · CBO 223505');
    expect(a.declaracao).toBe(texto);
    atestos.ubs23 = a;
    expect((await atestar('medica', { unitId: U.ubs!.id, semana: '202623' }, 409)).body.code).toBe('CONFLITO');
    // 14h01 em Brasília: fora do prazo.
    relogio(SEGUNDA_1401);
    atestos.upa23 = (await atestar('enfermeiro', { unitId: U.upa!.id, semana: '202623' }, 201)).body;
    expect(atestos.upa23.atrasado).toBe(true);
    // O substituto também atesta (a SE 202622 venceu na segunda anterior).
    atestos.ubs22 = (await atestar('medica', { unitId: U.ubs!.id, semana: '202622' }, 201)).body;
    expect(atestos.ubs22).toMatchObject({ atrasado: true, atestadoPor: 'Carla Menezes Médica' });
    const linha = await db.negativeReport.findUniqueOrThrow({ where: { id: a.id } });
    expect(linha).toMatchObject({ attestedBy: usuario.enfermeiro, attesterName: 'Bruno Almeida Enfermeiro', attesterCbo: '223505', late: false, onBehalf: false });
    expect(linha.attestedAt.toISOString()).toBe(SEGUNDA_1359.toISOString());
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.negativa_atestar', entityId: a.id } })).toBe(1);
  });

  it('só atesta quem tem designação ativa: revogado, gestor e profissional sem designação recebem 403', async () => {
    relogio(QUARTA);
    const ubs = (await t.http().get('/api/vigilancia/unidades-notificantes').set(auth('vig')).expect(200)).body.find((u: { unidade: { id: string } }) => u.unidade.id === U.ubs!.id);
    const carla = ubs.responsaveis.find((r: { nome: string }) => r.nome === 'Carla Menezes Médica');
    expect((await t.http().post(`/api/vigilancia/responsaveis/${carla.id}/revogar`).set(auth('vig')).expect(200)).body).toEqual({ ok: true });
    expect((await t.http().post(`/api/vigilancia/responsaveis/${carla.id}/revogar`).set(auth('vig')).expect(422)).body.code).toBe('JA_REVOGADA');
    await atestar('medica', { unitId: U.ubs!.id, semana: '202621' }, 403);
    await atestar('gestora', { unitId: U.ubs!.id, semana: '202621' }, 403);
    await atestar('cardio', { unitId: U.poli!.id, semana: '202621' }, 403);
    // A recepção não tem a tela da negativa.
    await atestar('recepcao', { unitId: U.ubs!.id, semana: '202621' }, 403);
    // O atesto já feito pela substituta continua valendo.
    expect((await db.negativeReport.findUniqueOrThrow({ where: { id: atestos.ubs22!.id } })).status).toBe('ATESTADA');
  });

  it('em nome da unidade: só com vigilancia.consolidacao e motivo', async () => {
    relogio(QUARTA);
    await atestar('vig', { unitId: U.ubs2!.id, semana: '202621' }, 403);
    await atestar('vig', { unitId: U.ubs2!.id, semana: '202621', emNome: { motivo: 'curto' } }, 400);
    const a = (await atestar('vig', { unitId: U.ubs2!.id, semana: '202621', emNome: { motivo: 'Informação recebida por telefone; unidade sem responsável designado.' } }, 201)).body as Atesto;
    expect(a).toMatchObject({ emNome: true, motivoEmNome: 'Informação recebida por telefone; unidade sem responsável designado.', atestadoPor: 'Vera Lúcia Vigilância Epidemiológica', atrasado: true });
    expect(a.declaracao).toContain('em nome da unidade');
    atestos.ubs2_21 = a;
    // O responsável designado não atesta "em nome" (não tem vigilancia.consolidacao).
    await atestar('enfermeiro', { unitId: U.ubs!.id, semana: '202620', emNome: { motivo: 'Tentativa de atesto em nome da unidade.' } }, 403);
  });

  it('semana em curso, semana futura, fora da janela, semana inexistente e unidade fora do período são recusadas', async () => {
    relogio(QUARTA);
    expect((await atestar('enfermeiro', { unitId: U.ubs!.id, semana: '202624' }, 422)).body.code).toBe('SEMANA_EM_CURSO');
    expect((await atestar('enfermeiro', { unitId: U.ubs!.id, semana: '202626' }, 422)).body.code).toBe('SEMANA_EM_CURSO');
    // semanasAtesto = 8: de 202616 a 202623.
    expect((await atestar('enfermeiro', { unitId: U.ubs!.id, semana: '202615' }, 422)).body.code).toBe('FORA_DO_PERIODO');
    expect((await atestar('enfermeiro', { unitId: U.ubs!.id, semana: '202699' }, 400)).body.code).toBe('SEMANA_INVALIDA');
    // A policlínica é notificante desde 01/05/2026 (SE 202617).
    expect((await atestar('nir', { unitId: U.poli!.id, semana: '202616' }, 422)).body.code).toBe('NAO_NOTIFICANTE');
  });

  it('RQ002: notificação, rascunho, surto e registro oficial da unidade na semana impedem o atesto', async () => {
    relogio(QUARTA);
    const n = await novaNotificacao({ unitId: U.hosp!.id, status: 'NOTIFICADA', epiWeekNotified: '202622', knownAt: new Date('2026-06-01T12:00:00Z'), notifiedAt: new Date('2026-06-01T12:00:00Z') });
    const e1 = (await atestar('enfermeiro', { unitId: U.hosp!.id, semana: '202622' }, 422)).body;
    expect(e1.code).toBe('SEMANA_COM_NOTIFICACAO');
    expect(e1.message).toContain(n.numero);
    // Rascunho conhecido na semana (terça, 26/05): confirme ou descarte antes.
    await novaNotificacao({ unitId: U.hosp!.id, knownAt: new Date('2026-05-26T12:00:00Z') });
    const e2 = (await atestar('enfermeiro', { unitId: U.hosp!.id, semana: '202621' }, 422)).body;
    expect(e2.code).toBe('SEMANA_COM_RASCUNHO');
    expect(e2.message).toContain('confirme ou descarte o rascunho antes');
    const surto = await surtoNoBanco('hosp', '2026-05-20', '2026/9001');
    const e3 = (await atestar('enfermeiro', { unitId: U.hosp!.id, semana: '202620' }, 422)).body;
    expect(e3).toMatchObject({ code: 'SEMANA_COM_SURTO' });
    expect(e3.message).toContain(surto.number);
    await registroOficial({ tipo: 'INDIVIDUAL', unidade: 'hosp', semana: '202619', numero: '1234501' });
    const e4 = (await atestar('enfermeiro', { unitId: U.hosp!.id, semana: '202619' }, 422)).body;
    expect(e4.code).toBe('SEMANA_COM_REGISTRO_OFICIAL');
    expect(e4.message).toContain('1234501');
    // Registro excluído no sistema oficial não conta.
    await registroOficial({ tipo: 'INDIVIDUAL', unidade: 'hosp', semana: '202618', numero: '1234502', excluido: true });
    atestos.hosp18 = (await atestar('enfermeiro', { unitId: U.hosp!.id, semana: '202618' }, 201)).body;
  });

  it('RQ003 pelo job: o atesto cai quando aparece notificação, surto ou registro oficial; a prévia vencida expira', async () => {
    relogio(QUARTA);
    const emNome = { motivo: 'Informação recebida por telefone da unidade.' };
    const a20 = (await atestar('vig', { unitId: U.ubs2!.id, semana: '202620', emNome }, 201)).body as Atesto;
    const a19 = (await atestar('vig', { unitId: U.ubs2!.id, semana: '202619', emNome }, 201)).body as Atesto;
    const a17 = (await atestar('vig', { unitId: U.ubs2!.id, semana: '202617', emNome }, 201)).body as Atesto;
    // Chegam depois do atesto, sem passar pelo gancho da confirmação: notificação, surto e registro oficial.
    const n = await novaNotificacao({ unitId: U.ubs2!.id, status: 'NOTIFICADA', epiWeekNotified: '202620', knownAt: new Date('2026-05-18T12:00:00Z'), notifiedAt: new Date('2026-05-18T12:00:00Z') });
    const s = await surtoNoBanco('ubs2', '2026-05-12', '2026/9002');
    const reg = await registroOficial({ tipo: 'SURTO', unidade: 'ubs2', semana: '202617', numero: '7654321' });
    // Prévia de importação criada há 30 h (o padrão expira em 24 h).
    const previa = await db.officialImport.create({
      data: {
        system: 'SINAN_NET',
        status: 'PREVIA',
        fileName: 'previa-vencida.dbf',
        sha256: 'e'.repeat(64),
        sizeBytes: 3,
        payload: Buffer.from([1, 2, 3]),
        createdBy: usuario.vigilancia!,
        createdAt: new Date(Date.now() - 30 * H),
      },
    });
    const r = await tarefa();
    expect(r.negativasCanceladas).toBe(3);
    expect(r.previasExpiradas).toBeGreaterThanOrEqual(1);
    expect(await db.officialImport.findUniqueOrThrow({ where: { id: previa.id }, select: { status: true, payload: true } })).toEqual({ status: 'DESCARTADA', payload: null });
    const [c20, c19, c17] = await Promise.all([a20, a19, a17].map((a) => db.negativeReport.findUniqueOrThrow({ where: { id: a.id } })));
    expect(c20).toMatchObject({ status: 'CANCELADA', causeNotificationId: n.id, causeOutbreakId: null, causeRecordId: null });
    expect(c20!.cancelReason).toContain(n.numero);
    expect(c20!.cancelReason).toContain('RQ003');
    expect(c19).toMatchObject({ status: 'CANCELADA', causeOutbreakId: s.id });
    expect(c17).toMatchObject({ status: 'CANCELADA', causeRecordId: reg.id });
    // Idempotente; e a semana agora com notificação não aceita atesto novo (RQ002).
    expect((await tarefa()).negativasCanceladas).toBe(0);
    expect((await atestar('vig', { unitId: U.ubs2!.id, semana: '202620', emNome }, 422)).body.code).toBe('SEMANA_COM_NOTIFICACAO');
    // O atesto cancelado aparece no histórico com a causa.
    const hist = (await t.http().get('/api/vigilancia/negativas/minhas').set(auth('enfermeiro')).expect(200)).body.historico as Atesto[];
    expect(hist.find((h) => h.id === atestos.ubs23!.id)).toMatchObject({ status: 'ATESTADA' });
  });

  it('RQ003 pelo gancho: confirmar a notificação cancela o atesto da unidade na semana dela', async () => {
    // A semana real da confirmação fica fechada para o serviço da negativa (relógio duas semanas à frente).
    const semanaReal = semanaEpidemiologica(new Date(), TZ).codigo;
    relogio(new Date(Date.now() + 14 * DIA));
    const n = await novaNotificacao({ unitId: U.ubs!.id, knownAt: new Date(Date.now() - 8 * DIA) });
    const a = (await atestar('enfermeiro', { unitId: U.ubs!.id, semana: semanaReal }, 201)).body as Atesto;
    const c = (await t.http().post(`/api/vigilancia/notificacoes/${n.id}/confirmar`).set(auth('medica')).expect(200)).body;
    expect(c.status).toBe('NOTIFICADA');
    const depois = await db.negativeReport.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois).toMatchObject({ status: 'CANCELADA', causeNotificationId: n.id });
    expect((await db.notification.findUniqueOrThrow({ where: { id: n.id } })).epiWeekNotified).toBe(semanaReal);
  });

  it('NNEGANET: o atesto casa com a negativa digitada no Sinan e as diferenças aparecem na grade', async () => {
    relogio(QUARTA);
    const neg = await registroOficial({ tipo: 'NEGATIVA', unidade: 'ubs', semana: '202623', numero: '9000101' });
    const semAtesto = await registroOficial({ tipo: 'NEGATIVA', unidade: 'ubs2', semana: '202622', numero: '9000102' });
    await negativas.reconciliar(db);
    expect((await db.negativeReport.findUniqueOrThrow({ where: { id: atestos.ubs23!.id } })).officialRecordId).toBe(neg.id);
    const g = await grade('semanas=6');
    expect(celula(g, 'ubs', '202623')).toMatchObject({ situacao: 'NEGATIVA', fontes: { negativaSinan: true, atesto: { id: atestos.ubs23!.id, atrasado: false } } });
    expect(celula(g, 'ubs2', '202622')).toMatchObject({ situacao: 'NEGATIVA', fontes: { negativaSinan: true, atesto: null } });
    expect(g.sinanSemAtesto).toContainEqual(expect.objectContaining({ semana: '202622', unidade: expect.objectContaining({ id: U.ubs2!.id }), registroOficialId: semAtesto.id }));
    expect(g.atestadoSemSinan).toContainEqual(expect.objectContaining({ semana: '202623', unidade: expect.objectContaining({ id: U.upa!.id }), atestoId: atestos.upa23!.id }));
    expect(g.atestadoSemSinan.find((d) => d.unidade.id === U.ubs!.id && d.semana === '202623')).toBeUndefined();
  });

  it('grade: situações por unidade e semana, silenciosas, só negativas, % por semana e regularidade do município', async () => {
    relogio(QUARTA);
    // A UPA só manda negativa: 11 semanas atestadas além da SE 202623.
    await db.negativeReport.createMany({
      data: Array.from({ length: 11 }, (_, i) => deslocarSemana('202612', i)).map((semana) => ({
        unitId: U.upa!.id,
        epiWeek: semana,
        attestedBy: usuario.enfermeiro!,
        attestedAt: new Date('2026-06-15T12:00:00Z'),
        attesterName: 'Bruno Almeida Enfermeiro',
        declaration: 'Atesto de teste.',
        late: true,
      })),
    });
    const g = await grade('semanas=6');
    expect(g.colunas.map((c) => c.semana)).toEqual(['202619', '202620', '202621', '202622', '202623', '202624']);
    expect(g.colunas.map((c) => c.fechada)).toEqual([true, true, true, true, true, false]);
    expect(g.metaPercentual).toBe(80);
    const linha = (k: string) => g.linhas.find((l) => l.unidade.id === U[k]!.id)!.celulas.map((c) => c.situacao);
    expect(linha('ubs')).toEqual(['SEM_INFORMACAO', 'SEM_INFORMACAO', 'SEM_INFORMACAO', 'NEGATIVA_ATRASADA', 'NEGATIVA', 'EM_CURSO']);
    expect(linha('ubs2')).toEqual(['POSITIVA', 'POSITIVA', 'NEGATIVA_ATRASADA', 'NEGATIVA', 'SEM_INFORMACAO', 'EM_CURSO']);
    expect(linha('upa')).toEqual(['NEGATIVA_ATRASADA', 'NEGATIVA_ATRASADA', 'NEGATIVA_ATRASADA', 'NEGATIVA_ATRASADA', 'NEGATIVA_ATRASADA', 'EM_CURSO']);
    // O rascunho não é informação: a SE 202621 do hospital fica sem informação.
    expect(linha('hosp')).toEqual(['POSITIVA', 'POSITIVA', 'SEM_INFORMACAO', 'POSITIVA', 'SEM_INFORMACAO', 'EM_CURSO']);
    expect(linha('ceo')).toEqual(['SEM_INFORMACAO', 'SEM_INFORMACAO', 'SEM_INFORMACAO', 'SEM_INFORMACAO', 'SEM_INFORMACAO', 'EM_CURSO']);
    expect(celula(g, 'hosp', '202619').fontes).toMatchObject({ registrosOficiais: 1, notificacoes: 0, surtos: 0 });
    expect(celula(g, 'hosp', '202620').fontes).toMatchObject({ surtos: 1 });
    expect(celula(g, 'hosp', '202622').fontes).toMatchObject({ notificacoes: 1 });
    // O CAPS sem período não entra; farmácia, almoxarifado e vigilância também não.
    expect(g.linhas.map((l) => l.unidade.nome).sort()).toEqual(['CEO Sorriso', 'Hospital Municipal São Lucas', 'Policlínica Municipal', 'UBS Centro', 'UBS Jardim das Flores', 'UPA 24h Norte']);
    expect(g.analise.silenciosas.map((s) => [s.unitId, s.semanasSeguidas]).sort()).toEqual(
      [
        [U.ceo!.id, 5],
        [U.poli!.id, 5],
      ].sort(),
    );
    // % por semana: positiva, negativa e atrasada (contaAtrasada) sobre as 6 notificantes; a semana em curso não conta.
    expect(g.analise.percentualPorSemana[4]).toMatchObject({ comInformacao: 2, notificantes: 6 });
    expect(g.analise.percentualPorSemana[4]!.percentual).toBeCloseTo(33.33, 2);
    expect(g.analise.percentualPorSemana[3]).toMatchObject({ comInformacao: 4, notificantes: 6 });
    expect(g.analise.percentualPorSemana[5]).toMatchObject({ comInformacao: 0, notificantes: 0, percentual: null });
    expect(g.analise.regularidadeMunicipal).toEqual({ semanasSemInformacao: 0, irregular: false });
    expect(g.analise.soNegativas).toEqual([]);
    expect(g.avisos.some((a) => a.includes('regularidade do município'))).toBe(true);
    // Só negativas nas últimas 12 semanas fechadas (grade de 14 semanas).
    const g14 = await grade('semanas=14');
    expect(g14.analise.soNegativas).toEqual([{ unitId: U.upa!.id, semanas: 12 }]);
    // Antes do prazo da SE 202623 (segunda, 13h59), quem não atestou está "aguardando" e entra no denominador.
    relogio(SEGUNDA_1359);
    const gSeg = await grade('semanas=6');
    expect(celula(gSeg, 'ceo', '202623').situacao).toBe('AGUARDANDO');
    expect(gSeg.analise.silenciosas.find((s) => s.unitId === U.ceo!.id)!.semanasSeguidas).toBe(4);
    expect(gSeg.analise.percentualPorSemana[4]).toMatchObject({ notificantes: 6 });
    // Regularidade: 10 semanas fechadas sem nenhuma informação no município (PRC nº 6/2017, art. 454-E: 8).
    relogio(QUARTA);
    const antiga = await grade('semanas=10&ate=202610');
    expect(antiga.analise.regularidadeMunicipal).toEqual({ semanasSemInformacao: 10, irregular: true });
    expect(celula(antiga, 'ubs', '202610').situacao).toBe('SEM_INFORMACAO');
    // A policlínica não era notificante no período inteiro: fica fora da grade.
    expect(antiga.linhas.find((l) => l.unidade.id === U.poli!.id)).toBeUndefined();
    // Fora do período (antes de 01/05/2026, SE 202617), a célula é "não notificante".
    const virada = await grade('semanas=4&ate=202618');
    expect(virada.linhas.find((l) => l.unidade.id === U.poli!.id)!.celulas.map((c) => c.situacao)).toEqual(['NAO_NOTIFICANTE', 'NAO_NOTIFICANTE', 'SEM_INFORMACAO', 'SEM_INFORMACAO']);
    // A vigilância também lê; o profissional sem resumo nem painel, não.
    await grade('semanas=6', 'vig');
    await t.http().get('/api/vigilancia/negativas/grade').set(auth('enfermeiro')).expect(403);
  });

  it('espelho em PDF: unidade, SE, texto, nome, função e "fora do prazo"; só de quem atestou, da unidade ou da vigilância', async () => {
    relogio(QUARTA);
    const pdf = await t
      .http()
      .get(`/api/vigilancia/negativas/${atestos.ubs23!.id}/espelho.pdf`)
      .set(auth('enfermeiro'))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('negativa-9000011-202623.pdf');
    const corpo = pdf.body as Buffer;
    expect(corpo.subarray(0, 5).toString()).toBe('%PDF-');
    const texto = textoDoPdf(corpo);
    expect(texto).toContain('NOTIFICAÇÃO NEGATIVA SEMANAL');
    expect(texto).toContain('SE 23/2026: de 07/06/2026 a 13/06/2026.');
    expect(texto).toContain('No prazo');
    expect(texto).toContain('Bruno Almeida Enfermeiro');
    const atrasado = await t
      .http()
      .get(`/api/vigilancia/negativas/${atestos.upa23!.id}/espelho.pdf`)
      .set(auth('vig'))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      })
      .expect(200);
    expect(textoDoPdf(atrasado.body as Buffer)).toContain('FORA DO PRAZO');
    // O gestor tem a tela, mas não atestou nem é responsável da unidade.
    await t.http().get(`/api/vigilancia/negativas/${atestos.ubs23!.id}/espelho.pdf`).set(auth('gestora')).expect(403);
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.negativa_espelho' } })).toBe(2);
  });

  it('anular: só a vigilância, com motivo; a semana volta a ficar sem informação e aceita atesto novo', async () => {
    relogio(QUARTA);
    await t.http().post(`/api/vigilancia/negativas/${atestos.ubs2_21!.id}/anular`).set(auth('enfermeiro')).send({ motivo: 'Anulação pedida pelo responsável.' }).expect(403);
    await t.http().post(`/api/vigilancia/negativas/${atestos.ubs2_21!.id}/anular`).set(auth('vig')).send({ motivo: 'curto' }).expect(400);
    const a = (await t.http().post(`/api/vigilancia/negativas/${atestos.ubs2_21!.id}/anular`).set(auth('vig')).send({ motivo: 'A unidade teve caso suspeito não notificado na semana.' }).expect(200)).body as Atesto & {
      motivoCancelamento: string;
    };
    expect(a).toMatchObject({ status: 'ANULADA', motivoCancelamento: 'A unidade teve caso suspeito não notificado na semana.' });
    expect((await t.http().post(`/api/vigilancia/negativas/${atestos.ubs2_21!.id}/anular`).set(auth('vig')).send({ motivo: 'Segunda anulação do mesmo atesto.' }).expect(422)).body.code).toBe('NAO_ATESTADA');
    expect(celula(await grade('semanas=6'), 'ubs2', '202621').situacao).toBe('SEM_INFORMACAO');
    await atestar('vig', { unitId: U.ubs2!.id, semana: '202621', emNome: { motivo: 'Novo atesto depois da anulação, por telefone.' } }, 201);
  });
});
