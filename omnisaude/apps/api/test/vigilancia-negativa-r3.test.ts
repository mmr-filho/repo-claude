import { canonicalJson, demoFixtures, sha256, tenantSettings, type MasterClient } from '@omnisaude/database';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MASTER_DB, TenantsService } from '../src/core/database';
import { AdminService } from '../src/modules/admin/admin.service';
import { AiService } from '../src/modules/integrations/ai.service';
import { NegativaService } from '../src/modules/vigilancia/negativa.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Semana 27, terceira rodada da notificação negativa e do cadastro: a unidade reativada cujo período terminou na
 * desativação ganha aviso e conta em "sem configuração" (sur-7); a desativação encurta o período encerrado com fim
 * depois dela (NEGATIVA-2) e apaga, com trilha, o período e as designações que só começariam depois (NEGATIVA-3); a
 * designação de quem perdeu a lotação, o papel ou o acesso não vale e não trava a vaga de titular (NEGATIVA-4); e os
 * salvamentos simultâneos das configurações não se perdem (NEGATIVA-5). Relógios fixos; dados sintéticos.
 */
const enabled = await pgAvailable();
const MOTIVO = 'Unidade desativada no cadastro';
const AVISO_REATIVADA = 'Unidade reativada: o período de notificante terminou na desativação. Abra um período novo se ela voltou a notificar.';
const AVISO_TITULAR = 'Titular sem lotação ativa na unidade em papel que atesta: a designação não vale.';
// Quarta-feira 17/06/2026 (SE 24, 14 a 20/06), meio-dia em Brasília; as outras datas, no mesmo horário.
const QUARTA_1706 = new Date('2026-06-17T15:00:00Z');
const QUINTA_1806 = new Date('2026-06-18T15:00:00Z');
const QUARTA_2406 = new Date('2026-06-24T15:00:00Z');
const QUARTA_1507 = new Date('2026-07-15T15:00:00Z');
const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const hash = (payload: unknown) => sha256(canonicalJson(payload));

type Responsavel = { nome: string; tipo: string; ate: string | null; valido: boolean | null; motivoInvalido: string | null };
type Unidade = {
  unidade: { id: string; nome: string };
  ativa: boolean;
  periodoAtual: { desde: string; ate: string | null } | null;
  periodos: { desde: string; ate: string | null; motivoFim: string | null }[];
  responsaveis: Responsavel[];
  semConfiguracao: boolean;
  avisos: string[];
};
type Grade = { linhas: { unidade: { id: string }; celulas: { semana: string; situacao: string }[] }[]; analise: { silenciosas: { unitId: string }[] }; avisos: string[] };

describe.runIf(enabled)('Notificação negativa e cadastro: terceira rodada da semana 27', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let admin: AdminService;
  let negativas: NegativaService;
  const tk: Record<string, string> = {};
  const usuario: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const relogio = (d: Date) => {
    admin.agora = () => d;
    negativas.agora = () => d;
  };
  const trilha = (action: string, entityId: string) => db.auditEntry.findMany({ where: { action, entityId }, orderBy: { seq: 'asc' }, select: { userId: true, entityType: true, payloadHash: true } });
  /** Unidade nova (pelo cadastro) com as lotações dadas: [usuário, papel, CBO]. */
  const novaUnidade = async (name: string, cnes: string, lotados: [string, string, string][] = []) => {
    const u = (await t.http().post('/api/admin/units').set(auth('gestora')).send({ name, type: 'UBS', cnes, ibgeCode: '3550308' }).expect(201)).body as { id: string; cnes: string };
    for (const [k, role, cbo] of lotados) await db.userAssignment.create({ data: { userId: usuario[k]!, unitId: u.id, role: role as 'ENFERMAGEM', cbo } });
    return u;
  };
  const abrir = (unitId: string, desde: string) => t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId, desde }).expect(201);
  const encerrar = (unitId: string, ate: string, motivo: string) => t.http().post(`/api/vigilancia/unidades-notificantes/${unitId}/encerrar`).set(auth('vig')).send({ ate, motivo }).expect(200);
  const designar = (unitId: string, userKey: string, tipo: string, desde: string, status = 201) =>
    t.http().post(`/api/vigilancia/unidades-notificantes/${unitId}/responsaveis`).set(auth('vig')).send({ userId: usuario[userKey], tipo, desde }).expect(status);
  const ativa = (unitId: string, active: boolean) => t.http().patch(`/api/admin/units/${unitId}`).set(auth('gestora')).send({ active }).expect(200);
  const lista = async () => (await t.http().get('/api/vigilancia/unidades-notificantes').set(auth('vig')).expect(200)).body as Unidade[];
  const daLista = async (id: string) => (await lista()).find((u) => u.unidade.id === id)!;
  const grade = async (q: string) => (await t.http().get(`/api/vigilancia/negativas/grade?${q}`).set(auth('gestora')).expect(200)).body as Grade;
  /** Outra conexão ao banco da instituição, para segurar travas como uma transação concorrente. */
  const outraConexao = async () => {
    const url = new URL(TEST_PG);
    url.pathname = `/tenant_db_${t.slug.replace(/-/g, '_')}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };
  /** Espera (até 3 s) algum pedido da API ficar parado numa trava deste banco. */
  const esperarTrava = async (c: Client) => {
    for (let i = 0; i < 60; i++) {
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`);
      if (rows[0]!.n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const desativarSemEsperar = (unitId: string) =>
    t
      .http()
      .patch(`/api/admin/units/${unitId}`)
      .set(auth('gestora'))
      .send({ active: false })
      .then((x) => x);

  beforeAll(async () => {
    t = await startTestApp('vignegr3');
    t.app.get(AiService).client = null;
    tk.gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    admin = t.app.get(AdminService);
    negativas = t.app.get(NegativaService);
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
    // Começa sem a configuração da negativa que a semeadura da demonstração tenha gravado.
    for (const tabela of ['negative_reports', 'notifying_unit_responsibles', 'notifying_units']) await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
  });

  afterEach(() => {
    const agora = () => new Date();
    admin.agora = agora;
    negativas.agora = agora;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('sur-7: a unidade reativada cujo período terminou na desativação ganha aviso na lista e na grade e conta em "sem configuração"; nada se reabre', async () => {
    relogio(QUARTA_1706);
    const u = await novaUnidade('UBS R3 Reativada', '9002731');
    const mesmoDia = await novaUnidade('UBS R3 Mesmo Dia', '9002732');
    const encerrada = await novaUnidade('UBS R3 Encerrada pela Vigilancia', '9002733');
    const inativa = await novaUnidade('UBS R3 Continua Inativa', '9002734');
    for (const x of [u, mesmoDia, encerrada, inativa]) await abrir(x.id, '2026-01-01');
    await encerrar(encerrada.id, '2026-05-31', 'Reforma do prédio');
    // Quarta 17/06: desativadas no cadastro. A do mesmo dia é reativada em seguida (o clique por engano).
    for (const x of [u, mesmoDia, inativa]) await ativa(x.id, false);
    await ativa(mesmoDia.id, true);
    expect(await daLista(mesmoDia.id)).toMatchObject({
      ativa: true,
      semConfiguracao: true,
      periodoAtual: { desde: '2026-01-01', ate: '2026-06-17' },
      avisos: [AVISO_REATIVADA],
    });
    // Quinta 18/06: a outra é reativada. Na quarta seguinte, 24/06:
    relogio(QUINTA_1806);
    await ativa(u.id, true);
    relogio(QUARTA_2406);
    const l = await lista();
    const de = (id: string) => l.find((x) => x.unidade.id === id)!;
    expect(de(u.id)).toMatchObject({ ativa: true, semConfiguracao: true, periodoAtual: null, periodos: [{ desde: '2026-01-01', ate: '2026-06-17', motivoFim: MOTIVO }], avisos: [AVISO_REATIVADA] });
    // O período encerrado pela vigilância (outro motivo) e a unidade que continua inativa ficam sem o aviso.
    expect(de(encerrada.id)).toMatchObject({ ativa: true, semConfiguracao: false, avisos: [] });
    expect(de(inativa.id)).toMatchObject({ ativa: false, semConfiguracao: false, avisos: [] });
    // Nada foi reaberto sozinho.
    expect(await db.notifyingUnit.count({ where: { unitId: { in: [u.id, mesmoDia.id] }, until: null } })).toBe(0);

    // Na grade: o aviso com os nomes, e as duas contam entre as ativas sem período.
    const semPeriodo = (g: Grade) => Number(/^(\d+) unidade\(s\) ativa\(s\) sem período de unidade notificante/.exec(g.avisos.find((a) => a.includes('sem período de unidade notificante')) ?? '')?.[1] ?? 0);
    const g = await grade('semanas=4');
    expect(g.avisos).toContain('Unidades reativadas: o período de notificante de UBS R3 Mesmo Dia e UBS R3 Reativada terminou na desativação. Abra um período novo se elas voltaram a notificar.');
    // A vigilância abre um período novo: a unidade sai do aviso e da contagem.
    await abrir(u.id, '2026-06-25');
    expect(await daLista(u.id)).toMatchObject({ semConfiguracao: false, avisos: [], periodoAtual: { desde: '2026-06-25', ate: null } });
    const depois = await grade('semanas=4');
    expect(depois.avisos).toContain('Unidade reativada: o período de notificante de UBS R3 Mesmo Dia terminou na desativação. Abra um período novo se ela voltou a notificar.');
    expect(depois.avisos.some((a) => a.includes('UBS R3 Reativada'))).toBe(false);
    expect(semPeriodo(depois)).toBe(semPeriodo(g) - 1);
    expect(semPeriodo(g)).toBeGreaterThanOrEqual(2);
  });

  it('NEGATIVA-2: a desativação encurta o período encerrado com fim depois dela, com o fim anterior na trilha; sem aviso de "encerre"', async () => {
    relogio(QUARTA_1706);
    const u = await novaUnidade('UBS R3 Fim Futuro', '9002741');
    await abrir(u.id, '2026-01-01');
    // A vigilância encerra com data futura (transferência planejada); o gestor desativa antes.
    await encerrar(u.id, '2026-07-31', 'Transferência planejada');
    const desativadaEm = new Date('2026-06-17T18:00:00Z');
    relogio(desativadaEm);
    await ativa(u.id, false);
    const p = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: u.id } });
    expect({ desde: dia(p.since), ate: dia(p.until), motivo: p.endReason, por: p.endedBy, em: p.endedAt?.toISOString() }).toEqual({
      desde: '2026-01-01',
      ate: '2026-06-17',
      motivo: MOTIVO,
      por: usuario.gestora,
      em: desativadaEm.toISOString(),
    });
    expect(await trilha('vigilancia.notificante_encerrar', p.id)).toEqual([
      { userId: usuario.vigilancia, entityType: 'NotifyingUnit', payloadHash: hash({ unidade: u.cnes, ate: '2026-07-31', motivo: 'Transferência planejada' }) },
      { userId: usuario.gestora, entityType: 'NotifyingUnit', payloadHash: hash({ unidade: u.cnes, ate: '2026-06-17', motivo: MOTIVO, fimAnterior: '2026-07-31', motivoAnterior: 'Transferência planejada' }) },
    ]);
    // 24/06: sem período aberto, não há o que encerrar nem aviso.
    relogio(QUARTA_2406);
    expect(await daLista(u.id)).toMatchObject({ ativa: false, periodos: [{ desde: '2026-01-01', ate: '2026-06-17', motivoFim: MOTIVO }], avisos: [] });
    // 15/07: a SE 24 (a da desativação) ainda conta; da SE 25 em diante, "não notificante", fora das silenciosas.
    relogio(QUARTA_1507);
    const g = await grade('semanas=6&ate=202628');
    expect(g.linhas.find((l) => l.unidade.id === u.id)!.celulas.map((c) => [c.semana, c.situacao])).toEqual([
      ['202623', 'SEM_INFORMACAO'],
      ['202624', 'SEM_INFORMACAO'],
      ['202625', 'NAO_NOTIFICANTE'],
      ['202626', 'NAO_NOTIFICANTE'],
      ['202627', 'NAO_NOTIFICANTE'],
      ['202628', 'NAO_NOTIFICANTE'],
    ]);
    expect(g.analise.silenciosas.map((s) => s.unitId)).not.toContain(u.id);
    expect(g.avisos.filter((a) => a.includes('UBS R3 Fim Futuro'))).toEqual([]);
  });

  it('NEGATIVA-3: a desativação apaga, com trilha, o período e as designações que só começariam depois dela', async () => {
    relogio(QUARTA_1706);
    const nova = await novaUnidade('UBS R3 Ainda Nao Comecou', '9002751', [['enfermeiro', 'ENFERMAGEM', '223505']]);
    const comFutura = await novaUnidade('UBS R3 Substituta Futura', '9002752', [
      ['enfermeiro', 'ENFERMAGEM', '223505'],
      ['medica', 'MEDICO', '225125'],
    ]);
    await abrir(nova.id, '2026-07-01');
    await designar(nova.id, 'enfermeiro', 'TITULAR', '2026-07-01');
    await abrir(comFutura.id, '2026-01-01');
    await designar(comFutura.id, 'enfermeiro', 'TITULAR', '2026-01-01');
    await designar(comFutura.id, 'medica', 'SUBSTITUTO', '2026-06-20');
    const periodoNova = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: nova.id } });
    const designacaoNova = await db.notifyingUnitResponsible.findFirstOrThrow({ where: { unitId: nova.id } });
    const substituta = await db.notifyingUnitResponsible.findFirstOrThrow({ where: { unitId: comFutura.id, userId: usuario.medica } });
    await ativa(nova.id, false);
    await ativa(comFutura.id, false);
    // Apagados: não viram período nem designação de um dia no futuro.
    expect(await db.notifyingUnit.count({ where: { unitId: nova.id } })).toBe(0);
    expect(await db.notifyingUnitResponsible.count({ where: { unitId: nova.id } })).toBe(0);
    expect(await db.notifyingUnitResponsible.findUnique({ where: { id: substituta.id } })).toBeNull();
    // O que já valia termina no dia da desativação.
    const titular = await db.notifyingUnitResponsible.findFirstOrThrow({ where: { unitId: comFutura.id, userId: usuario.enfermeiro } });
    expect([dia(titular.until), titular.revokedBy]).toEqual(['2026-06-17', usuario.gestora]);
    expect(dia((await db.notifyingUnit.findFirstOrThrow({ where: { unitId: comFutura.id } })).until)).toBe('2026-06-17');
    // A trilha guarda o que foi apagado.
    expect(await trilha('vigilancia.notificante_excluir', periodoNova.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnit', payloadHash: hash({ unidade: nova.cnes, desde: '2026-07-01', ate: null, motivoFim: null, motivo: MOTIVO }) },
    ]);
    expect(await trilha('vigilancia.negativa_designacao_excluir', designacaoNova.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnitResponsible', payloadHash: hash({ unidade: nova.id, usuario: usuario.enfermeiro, tipo: 'TITULAR', desde: '2026-07-01', motivo: MOTIVO }) },
    ]);
    expect(await trilha('vigilancia.negativa_designacao_excluir', substituta.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnitResponsible', payloadHash: hash({ unidade: comFutura.id, usuario: usuario.medica, tipo: 'SUBSTITUTO', desde: '2026-06-20', motivo: MOTIVO }) },
    ]);
    // 24/06: a inativa que nunca chegou a ser notificante sai da lista; a outra fica sem nada a encerrar nem aviso.
    relogio(QUARTA_2406);
    const l = await lista();
    expect(l.find((x) => x.unidade.id === nova.id)).toBeUndefined();
    expect(l.find((x) => x.unidade.id === comFutura.id)).toMatchObject({
      ativa: false,
      periodoAtual: null,
      periodos: [{ desde: '2026-01-01', ate: '2026-06-17', motivoFim: MOTIVO }],
      semConfiguracao: false,
      avisos: [],
    });
    // 15/07: a unidade inativa não entra na grade (nem na SE 26, a de 01/07).
    relogio(QUARTA_1507);
    expect((await grade('semanas=6&ate=202628')).linhas.find((l) => l.unidade.id === nova.id)).toBeUndefined();
  });

  it('NEGATIVA-3: a desativação espera a designação em andamento e a encerra, sem fechar ciclo com a trava da trilha', async () => {
    relogio(QUARTA_1706);
    const u = await novaUnidade('UBS R3 Designacao Simultanea', '9002753', [['enfermeiro', 'ENFERMAGEM', '223505']]);
    await abrir(u.id, '2026-01-01');
    // Outra conexão faz o que a designação faz: trava a unidade, grava a designação e audita (a trava da trilha).
    const outra = await outraConexao();
    try {
      await outra.query('BEGIN');
      await outra.query(`SELECT pg_advisory_xact_lock(hashtext('negativa-responsavel:${u.id}'))`);
      const pedido = desativarSemEsperar(u.id);
      await esperarTrava(outra);
      await outra.query(`INSERT INTO notifying_unit_responsibles (id, unit_id, user_id, kind, since, designated_by) VALUES (gen_random_uuid(), $1, $2, 'TITULAR', DATE '2026-01-01', $3)`, [
        u.id,
        usuario.enfermeiro,
        usuario.vigilancia,
      ]);
      await outra.query(`SELECT pg_advisory_xact_lock(hashtext('omnisaude_audit_chain'))`);
      await outra.query('COMMIT');
      expect((await pedido).status).toBe(200);
    } finally {
      await outra.query('ROLLBACK').catch(() => {});
      await outra.end();
    }
    // A designação gravada durante a desativação também terminou no dia (a desativação a releu depois da trava).
    const d = await db.notifyingUnitResponsible.findFirstOrThrow({ where: { unitId: u.id } });
    expect([dia(d.until), d.revokedBy]).toEqual(['2026-06-17', usuario.gestora]);
    expect(dia((await db.notifyingUnit.findFirstOrThrow({ where: { unitId: u.id } })).until)).toBe('2026-06-17');
  });

  it('NEGATIVA-2: a desativação espera o encerramento em andamento da vigilância, relê o fim futuro e o encurta, sem impasse com a trilha', async () => {
    relogio(QUARTA_1706);
    const u = await novaUnidade('UBS R3 Encerramento Simultaneo', '9002742');
    await abrir(u.id, '2026-01-01');
    const p = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: u.id } });
    // Outra conexão faz o que o encerramento da vigilância faz: grava o fim (31/07) e audita (a trava da trilha).
    const outra = await outraConexao();
    try {
      await outra.query('BEGIN');
      await outra.query(`UPDATE notifying_units SET until = DATE '2026-07-31', end_reason = 'Transferência planejada', ended_by = $2, ended_at = now() WHERE id = $1 AND until IS NULL`, [p.id, usuario.vigilancia]);
      const pedido = desativarSemEsperar(u.id);
      await esperarTrava(outra);
      await outra.query(`SELECT pg_advisory_xact_lock(hashtext('omnisaude_audit_chain'))`);
      await outra.query('COMMIT');
      expect((await pedido).status).toBe(200);
    } finally {
      await outra.query('ROLLBACK').catch(() => {});
      await outra.end();
    }
    const depois = await db.notifyingUnit.findUniqueOrThrow({ where: { id: p.id } });
    expect([dia(depois.until), depois.endReason, depois.endedBy]).toEqual(['2026-06-17', MOTIVO, usuario.gestora]);
    expect(await trilha('vigilancia.notificante_encerrar', p.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnit', payloadHash: hash({ unidade: u.cnes, ate: '2026-06-17', motivo: MOTIVO, fimAnterior: '2026-07-31', motivoAnterior: 'Transferência planejada' }) },
    ]);
  });

  it('NEGATIVA-4: a designação de quem perdeu a lotação, o papel ou o acesso não vale; o aviso aparece e o novo titular a substitui', async () => {
    relogio(QUARTA_1706);
    const u = await novaUnidade('UBS R3 Titular', '9002761', [
      ['gestora', 'GESTOR', '131205'],
      ['enfermeiro', 'ENFERMAGEM', '223505'],
      ['tecnica', 'ENFERMAGEM', '322205'],
      ['medica', 'MEDICO', '225125'],
    ]);
    await abrir(u.id, '2026-01-01');
    await designar(u.id, 'gestora', 'TITULAR', '2026-01-01');
    await designar(u.id, 'enfermeiro', 'SUBSTITUTO', '2026-01-01');
    const marcas = (x: Unidade) => Object.fromEntries(x.responsaveis.map((r) => [r.nome, [r.tipo, r.ate, r.valido, r.motivoInvalido]]));
    const antes = await daLista(u.id);
    expect(marcas(antes)).toEqual({ 'Íris Campos Gestora': ['TITULAR', null, true, null], 'Bruno Almeida Enfermeiro': ['SUBSTITUTO', null, true, null] });
    expect(antes.avisos).toEqual([]);

    // A gestora perde a lotação na unidade; a designação dela continua no banco, mas não vale.
    await db.userAssignment.updateMany({ where: { userId: usuario.gestora, unitId: u.id }, data: { active: false } });
    const semLotacao = await daLista(u.id);
    expect(marcas(semLotacao)).toEqual({ 'Íris Campos Gestora': ['TITULAR', null, false, 'Sem lotação ativa na unidade'], 'Bruno Almeida Enfermeiro': ['SUBSTITUTO', null, true, null] });
    expect(semLotacao.avisos).toEqual([AVISO_TITULAR]);

    // O novo titular entra; a designação da gestora termina hoje, na mesma transação, com a trilha.
    const titularAntigo = await db.notifyingUnitResponsible.findFirstOrThrow({ where: { unitId: u.id, userId: usuario.gestora } });
    const r = (await designar(u.id, 'tecnica', 'TITULAR', '2026-06-17')).body as Unidade;
    expect(r.avisos).toEqual([]);
    expect(marcas(r)).toEqual({
      'Joana Lima Técnica de Enfermagem': ['TITULAR', null, true, null],
      'Bruno Almeida Enfermeiro': ['SUBSTITUTO', null, true, null],
      'Íris Campos Gestora': ['TITULAR', '2026-06-17', null, null],
    });
    const antigo = await db.notifyingUnitResponsible.findUniqueOrThrow({ where: { id: titularAntigo.id } });
    expect([dia(antigo.until), antigo.revokedBy, antigo.revokedAt?.toISOString()]).toEqual(['2026-06-17', usuario.vigilancia, QUARTA_1706.toISOString()]);
    expect(await trilha('vigilancia.negativa_revogar', titularAntigo.id)).toEqual([
      {
        userId: usuario.vigilancia,
        entityType: 'NotifyingUnitResponsible',
        payloadHash: hash({ unidade: u.id, usuario: usuario.gestora, tipo: 'TITULAR', ate: '2026-06-17', motivo: 'Novo titular designado: a designação não valia (sem lotação ativa na unidade)' }),
      },
    ]);
    // Com o titular que vale, outro titular continua recusado.
    expect((await designar(u.id, 'medica', 'TITULAR', '2026-06-17', 409)).body.message).toContain('Joana Lima Técnica de Enfermagem');

    // A técnica fica na unidade só com papel que não atesta (ACS).
    await db.userAssignment.updateMany({ where: { userId: usuario.tecnica, unitId: u.id }, data: { active: false } });
    await db.userAssignment.create({ data: { userId: usuario.tecnica!, unitId: u.id, role: 'ACS', cbo: '515105' } });
    const papel = await daLista(u.id);
    expect(marcas(papel)['Joana Lima Técnica de Enfermagem']).toEqual(['TITULAR', null, false, 'Papel nesta unidade não atesta a negativa']);
    expect(papel.avisos).toEqual([AVISO_TITULAR]);
    // A lotação de enfermagem volta, mas o acesso dela é desativado no cadastro.
    await db.userAssignment.updateMany({ where: { userId: usuario.tecnica, unitId: u.id, role: 'ENFERMAGEM' }, data: { active: true } });
    await db.user.update({ where: { id: usuario.tecnica }, data: { active: false } });
    try {
      const acesso = await daLista(u.id);
      expect(marcas(acesso)['Joana Lima Técnica de Enfermagem']).toEqual(['TITULAR', null, false, 'Acesso desativado no cadastro']);
      expect(acesso.avisos).toEqual(['Titular com o acesso desativado no cadastro: a designação não vale.']);
    } finally {
      await db.user.update({ where: { id: usuario.tecnica }, data: { active: true } });
    }
    const deVolta = await daLista(u.id);
    expect(marcas(deVolta)['Joana Lima Técnica de Enfermagem']).toEqual(['TITULAR', null, true, null]);
    expect(deVolta.avisos).toEqual([]);
  });

  it('NEGATIVA-5: salvamentos simultâneos de campos diferentes das configurações não se perdem', async () => {
    const patch = (corpo: Record<string, unknown>) => t.http().patch('/api/vigilancia/configuracoes').set(auth('vig')).send(corpo);
    const master = t.app.get(MASTER_DB) as MasterClient;
    const tenantId = (await t.app.get(TenantsService).resolve(t.slug)).id;
    // O que ficou gravado no banco mestre (não o cache das configurações da instituição).
    const gravado = async () => tenantSettings((await master.tenant.findUniqueOrThrow({ where: { id: tenantId } })).settings).vigilancia;
    const antes = await db.auditEntry.count({ where: { action: 'vigilancia.configuracoes' } });
    const rodadas = 10;
    for (let i = 0; i < rodadas; i++) {
      const hora = `1${i}:1${i}`;
      const dias = 400 + i;
      const ack = 30 + i;
      const respostas = await Promise.all([patch({ negativa: { prazoHora: hora } }), patch({ surto: { diasInusitado: dias } }), patch({ ackMinutes: ack })]);
      expect(respostas.map((x) => x.status)).toEqual([200, 200, 200]);
      const c = await gravado();
      expect([i, c.negativa.prazoHora, c.surto.diasInusitado, c.ackMinutes]).toEqual([i, hora, dias, ack]);
    }
    expect((await db.auditEntry.count({ where: { action: 'vigilancia.configuracoes' } })) - antes).toBe(rodadas * 3);
  });
});
