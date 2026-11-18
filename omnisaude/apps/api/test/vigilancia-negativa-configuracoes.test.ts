import { DEFAULT_TENANT_SETTINGS, demoFixtures, type MasterClient } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString, semanaEpidemiologica } from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MASTER_DB, TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { NegativaService } from '../src/modules/vigilancia/negativa.service';
import { NotificacaoService } from '../src/modules/vigilancia/notificacao.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

const enabled = await pgAvailable();
const TZ = 'America/Sao_Paulo';

/**
 * Configurações da semana 27 editáveis pela vigilância (K3: negativa, consolidação e os dias do evento inusitado, campo
 * a campo, com validação) e o vínculo automático da conciliação pela tarefa periódica 'vigilancia' (K5).
 */
describe.runIf(enabled)('Vigilância: configurações da semana 27 e vínculo automático pela tarefa (VIG-1c)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let tenants: TenantsService;
  let importacaoId = '';
  const tk: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const tarefa = async () => {
    tenants.connections.invalidate(t.slug);
    const tenant = await tenants.resolve(t.slug);
    return t.app.get(NotificacaoService).tarefa({ tenant, db: await tenants.client(tenant.id) });
  };
  const patch = (corpo: Record<string, unknown>, status: number) => t.http().patch('/api/vigilancia/configuracoes').set(auth('vig')).send(corpo).expect(status);

  beforeAll(async () => {
    t = await startTestApp('vignegconfig');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    for (const tabela of ['official_record_rejections', 'official_records', 'official_imports']) await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
    const vera = (await db.user.findUniqueOrThrow({ where: { cpf: demoFixtures.STAFF.find((s) => s.key === 'vigilancia')!.cpf } })).id;
    importacaoId = (await db.officialImport.create({ data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'teste-config.dbf', sha256: 'a'.repeat(64), sizeBytes: 1, createdBy: vera, appliedAt: new Date() } })).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('K3: grava negativa, consolidação e os dias do inusitado campo a campo, sem apagar as regras do surto', async () => {
    const master = t.app.get(MASTER_DB) as MasterClient;
    const tenantId = (await tenants.resolve(t.slug)).id;
    const regras = [{ id: 'bairro-3d', grupos: ['*'], vinculo: 'BAIRRO', minimo: 3, janelaDias: 3, descricao: 'Regra local de teste', fonte: 'Teste' }];
    const vigilancia = { ...DEFAULT_TENANT_SETTINGS.vigilancia, surto: { regras, diasInusitado: 365 } };
    await master.$executeRaw`UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{vigilancia}', ${JSON.stringify(vigilancia)}::jsonb) WHERE id = ${tenantId}::uuid`;
    tenants.connections.invalidate(t.slug);

    const r = (await patch({ negativa: { prazoDiaSemana: 2, prazoHora: '09:30' }, consolidacao: { expiraPreviaHoras: 48 }, surto: { diasInusitado: 180 } }, 200)).body;
    expect(r.negativa).toEqual({ ...DEFAULT_TENANT_SETTINGS.vigilancia.negativa, prazoDiaSemana: 2, prazoHora: '09:30' });
    expect(r.consolidacao).toEqual({ semanasIncompletas: 2, expiraPreviaHoras: 48 });
    expect(r.surto).toEqual({ regras, diasInusitado: 180 });
    const lido = (await t.http().get('/api/vigilancia/configuracoes').set(auth('vig')).expect(200)).body;
    expect(lido).toMatchObject({ negativa: { prazoDiaSemana: 2, prazoHora: '09:30' }, consolidacao: { expiraPreviaHoras: 48 }, surto: { regras, diasInusitado: 180 } });
    // Campo a campo: o que não vem fica como está; a tela do plantão não apaga os blocos novos.
    expect((await patch({ negativa: { semanasSilenciosa: 3, contaAtrasada: false } }, 200)).body.negativa).toMatchObject({ prazoDiaSemana: 2, prazoHora: '09:30', semanasSilenciosa: 3, contaAtrasada: false });
    const plantao = (await patch({ ackMinutes: 30 }, 200)).body;
    expect(plantao).toMatchObject({ ackMinutes: 30, negativa: { prazoHora: '09:30', semanasSilenciosa: 3 }, consolidacao: { expiraPreviaHoras: 48 }, surto: { regras, diasInusitado: 180 } });
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.configuracoes' } })).toBe(3);

    // O prazo novo vale para a grade (o cache do tenant é renovado ao salvar): SE 45/2026 vence na terça, 17/11, 9h30.
    t.app.get(NegativaService).agora = () => new Date('2026-11-18T15:00:00Z');
    const grade = (await t.http().get('/api/vigilancia/negativas/grade?semanas=2').set(auth('vig')).expect(200)).body as { colunas: { semana: string; prazo: string }[] };
    expect(grade.colunas.find((c) => c.semana === '202645')!.prazo).toBe('2026-11-17T12:30:00.000Z');
  });

  it('K3: recusa valor fora da faixa, hora fora de HH:MM e chave desconhecida no bloco; só a vigilância edita', async () => {
    const antes = (await t.http().get('/api/vigilancia/configuracoes').set(auth('vig')).expect(200)).body;
    for (const corpo of [
      { negativa: { prazoHora: '25:00' } },
      { negativa: { prazoHora: '9:30' } },
      { negativa: { prazoDiaSemana: 7 } },
      { negativa: { prazoDiaSemana: 1.5 } },
      { negativa: { metaPercentual: 0 } },
      { negativa: { metaPercentual: 101 } },
      { negativa: { semanasAtesto: 0 } },
      { negativa: { semanasSilenciosa: 53 } },
      { negativa: { semanasSoNegativa: 0 } },
      { negativa: { semanasRegularidadeMunicipal: 53 } },
      { negativa: { contaAtrasada: 'sim' } },
      { negativa: { semanasSilenciosas: 3 } },
      { consolidacao: { semanasIncompletas: 9 } },
      { consolidacao: { semanasIncompletas: -1 } },
      { consolidacao: { expiraPreviaHoras: 0 } },
      { consolidacao: { expiraPreviaHoras: 169 } },
      { surto: { diasInusitado: 29 } },
      { surto: { diasInusitado: 3651 } },
      { surto: { regras: [] } },
    ])
      expect((await patch(corpo, 400)).body.code).toBe('VALIDACAO');
    // Os limites entram.
    expect(
      (await patch({ negativa: { prazoDiaSemana: 0, prazoHora: '23:59', metaPercentual: 100, semanasAtesto: 52 }, consolidacao: { semanasIncompletas: 0, expiraPreviaHoras: 168 }, surto: { diasInusitado: 30 } }, 200))
        .body,
    ).toMatchObject({
      negativa: { prazoDiaSemana: 0, prazoHora: '23:59', metaPercentual: 100, semanasAtesto: 52 },
      consolidacao: { semanasIncompletas: 0, expiraPreviaHoras: 168 },
      surto: { diasInusitado: 30 },
    });
    await t
      .http()
      .patch('/api/vigilancia/configuracoes')
      .set(auth('gestora'))
      .send({ negativa: { prazoHora: '10:00' } })
      .expect(403);
    const depois = (await t.http().get('/api/vigilancia/configuracoes').set(auth('vig')).expect(200)).body;
    expect(depois.negativa).toMatchObject({ prazoHora: '23:59', semanasSilenciosa: antes.negativa.semanasSilenciosa });
  });

  it('K5: a tarefa vincula o registro oficial à notificação que ganhou o número depois da importação; com a trava ocupada, não espera', async () => {
    const p = (
      await t
        .http()
        .post('/api/patients')
        .set(auth('recepcao'))
        .send({
          name: 'Paciente Configuracao Vinculo Teste',
          birthDate: '1981-03-14',
          confirmNotDuplicate: true,
          sex: 'M',
          cpf: completeCpf('271900501'),
          cns: cnsFromBase('27190000501'),
          motherName: 'Mae Configuracao Vinculo',
          phone: '(11) 97777-2790',
          address: { cep: '01001000', street: 'Rua da Conciliação', number: '27', district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
        })
        .expect(201)
    ).body.id as string;
    const n = (await t.http().post('/api/vigilancia/notificacoes').set(auth('medica')).send({ patientId: p, conditionKey: 'coqueluche' }).expect(201)).body as { id: string };
    expect((await t.http().post(`/api/vigilancia/notificacoes/${n.id}/confirmar`).set(auth('medica')).expect(200)).body.status).toBe('NOTIFICADA');
    // O registro do Sinan Net chegou na importação antes de a vigilância informar o número: ficou sem vínculo.
    const agora = new Date();
    const hoje = localDateString(agora, TZ);
    const r = await db.officialRecord.create({
      data: {
        system: 'SINAN_NET',
        type: 'INDIVIDUAL',
        naturalKey: `7700123|${hoje}|355030|A379`,
        number: '7700123',
        notifiedOn: new Date(`${hoje}T00:00:00Z`),
        epiWeekNotified: semanaEpidemiologica(agora, TZ).codigo,
        municipalityIbge: '355030',
        unitCnes: demoFixtures.UNITS.find((u) => u.key === 'ubs')!.cnes,
        agravo: 'A379',
        groupKey: 'coqueluche',
        situation: 'EM_INVESTIGACAO',
        contentHash: 'b'.repeat(64),
        firstImportId: importacaoId,
        lastImportId: importacaoId,
        lastSeenAt: agora,
      },
    });
    expect((await tarefa()).vinculadosAutomaticamente).toBe(0);
    await t.http().post(`/api/vigilancia/notificacoes/${n.id}/numero-oficial`).set(auth('vig')).send({ numero: '7700123' }).expect(200);

    // Uma importação aplicando segura a trava da conciliação: a tarefa segue sem esperar e tenta na próxima vez.
    const url = new URL(TEST_PG);
    url.pathname = `/tenant_db_${t.slug.replace(/-/g, '_')}`;
    const outra = new Client({ connectionString: url.toString() });
    await outra.connect();
    try {
      await outra.query('BEGIN');
      await outra.query(`SELECT pg_advisory_xact_lock(hashtext('vigilancia:conciliacao'))`);
      const inicio = Date.now();
      expect((await tarefa()).vinculadosAutomaticamente).toBe(0);
      expect(Date.now() - inicio).toBeLessThan(10_000);
      expect((await db.officialRecord.findUniqueOrThrow({ where: { id: r.id } })).notificationId).toBeNull();
    } finally {
      await outra.query('ROLLBACK');
      await outra.end();
    }

    expect((await tarefa()).vinculadosAutomaticamente).toBe(1);
    expect(await db.officialRecord.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ notificationId: n.id, matchMethod: 'NUMERO_OFICIAL', matchedBy: null });
    // Idempotente.
    expect((await tarefa()).vinculadosAutomaticamente).toBe(0);
  });
});
