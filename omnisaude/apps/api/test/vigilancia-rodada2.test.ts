import { canonicalJson, demoFixtures, sha256 } from '@omnisaude/database';
import { cnsFromBase, completeCpf, localDateString, PLANO_MODELO_MS_2025, type SituacaoContingencia } from '@omnisaude/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AdminService } from '../src/modules/admin/admin.service';
import { AiService } from '../src/modules/integrations/ai.service';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { acoesDoEstagio, ContingenciaService } from '../src/modules/vigilancia/contingencia.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { NegativaService } from '../src/modules/vigilancia/negativa.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Semana 27, segunda rodada: pendências entre frentes. Unidade desativada no cadastro deixa de ser notificante (sur-7),
 * dois acionamentos do plano de contingência no mesmo dia (contingencia-mesmo-dia) e auditoria da leitura do caso
 * sigiloso do surto por quem pode abri-lo (surto-leitura-sigilosa). Os relógios dos serviços ficam em datas fixas onde
 * a regra depende do dia; dados sintéticos.
 */
const enabled = await pgAvailable();
const H = 3_600_000;
const DIA = 24 * H;
const TZ = 'America/Sao_Paulo';
const MOTIVO = 'Unidade desativada no cadastro';
const AVISO_REATIVADA = 'Unidade reativada: o período de notificante terminou na desativação. Abra um período novo se ela voltou a notificar.';
const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const hash = (payload: unknown) => sha256(canonicalJson(payload));

type Celula = { semana: string; situacao: string };
type Grade = { linhas: { unidade: { id: string; nome: string }; ativa: boolean; celulas: Celula[] }[]; analise: { silenciosas: { unitId: string }[] }; avisos: string[] };
type UnidadeNotificante = {
  unidade: { id: string };
  ativa: boolean;
  periodoAtual: unknown;
  periodos: { desde: string; ate: string | null; motivoFim: string | null }[];
  semConfiguracao: boolean;
  avisos: string[];
};
type Caso = { id: string; numero: number; restrito: boolean; iniciais: string | null };
type Detalhe = { id: string; numero: string; planilha: Caso[]; espelho: { planilha: { NU_CASO: string; NM_CASO: string | null }[] } };

describe.runIf(enabled)('Vigilância: pendências entre frentes da semana 27 (segunda rodada)', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  const tk: Record<string, string> = {};
  const U: Record<string, { id: string; cnes: string }> = {};
  const usuario: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const trilha = (action: string, entityId: string) => db.auditEntry.findMany({ where: { action, entityId }, orderBy: { seq: 'asc' }, select: { userId: true, entityType: true, payloadHash: true } });

  beforeAll(async () => {
    t = await startTestApp('vigrodada2');
    t.app.get(AiService).client = null;
    tk.recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    tk.medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    tk.enfermeiro = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    tk.gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    tk.nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    db = await tenants.client(tenant.id);
    await t.app.get(CatalogoVigilanciaService).garantir({ tenant, db });
    for (const u of demoFixtures.UNITS) U[u.key] = { id: (await db.unit.findUniqueOrThrow({ where: { cnes: u.cnes } })).id, cnes: u.cnes };
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
  });

  afterEach(() => {
    // Os relógios voltam ao normal entre os testes.
    const agora = () => new Date();
    t.app.get(AdminService).agora = agora;
    t.app.get(NegativaService).agora = agora;
    t.app.get(ContingenciaService).agora = agora;
    t.app.get(DiagramaService).agora = agora;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('sur-7: desativar a unidade encerra o período de notificante e as designações no dia da instituição, com auditoria; o que começaria depois é apagado; reativar não reabre e avisa', async () => {
    const admin = t.app.get(AdminService);
    const negativas = t.app.get(NegativaService);
    const novaUnidade = async (name: string, cnes: string) =>
      (await t.http().post('/api/admin/units').set(auth('gestora')).send({ name, type: 'UBS', cnes, ibgeCode: '3550308' }).expect(201)).body as { id: string; cnes: string };
    const u = await novaUnidade('UBS Rodada Dois', '9002701');
    const futura = await novaUnidade('UBS Rodada Dois Futura', '9002702');
    await db.userAssignment.createMany({
      data: [
        { userId: usuario.enfermeiro!, unitId: u.id, role: 'ENFERMAGEM', cbo: '223505' },
        { userId: usuario.medica!, unitId: u.id, role: 'MEDICO', cbo: '225125' },
        { userId: usuario.tecnica!, unitId: u.id, role: 'ENFERMAGEM', cbo: '322205' },
      ],
    });
    negativas.agora = () => new Date('2026-03-10T15:00:00Z');
    await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: u.id, desde: '2026-01-01' }).expect(201);
    // A outra unidade só passaria a ser notificante depois da data da desativação.
    await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: futura.id, desde: '2026-07-01' }).expect(201);
    const designar = (userKey: string, tipo: string, desde: string) =>
      t.http().post(`/api/vigilancia/unidades-notificantes/${u.id}/responsaveis`).set(auth('vig')).send({ userId: usuario[userKey], tipo, desde }).expect(201);
    await designar('enfermeiro', 'TITULAR', '2026-01-01');
    await designar('medica', 'SUBSTITUTO', '2026-01-01');
    // A técnica só começaria depois da desativação.
    await designar('tecnica', 'SUBSTITUTO', '2026-06-20');
    const designacao = (userKey: string) => db.notifyingUnitResponsible.findFirstOrThrow({ where: { unitId: u.id, userId: usuario[userKey] } });
    // A designação da médica já tinha terminado em 10/03 (revogada pela vigilância): fica como está.
    const medica = await designacao('medica');
    await t.http().post(`/api/vigilancia/responsaveis/${medica.id}/revogar`).set(auth('vig')).expect(200);

    // O que só começaria depois da desativação (o período da outra unidade e a designação da técnica) é apagado.
    const periodoFutura = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: futura.id } });
    const tecnica = await designacao('tecnica');
    // Quarta-feira, 17/06/2026, 23h30 em Brasília (já 18/06 em UTC): o fim é o dia da instituição.
    const desativadaEm = new Date('2026-06-18T02:30:00Z');
    admin.agora = () => desativadaEm;
    expect((await t.http().patch(`/api/admin/units/${u.id}`).set(auth('gestora')).send({ active: false }).expect(200)).body).toMatchObject({ active: false });
    await t.http().patch(`/api/admin/units/${futura.id}`).set(auth('gestora')).send({ active: false }).expect(200);

    const periodo = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: u.id } });
    expect({ ate: dia(periodo.until), motivo: periodo.endReason, por: periodo.endedBy, em: periodo.endedAt?.toISOString() }).toEqual({
      ate: '2026-06-17',
      motivo: MOTIVO,
      por: usuario.gestora,
      em: desativadaEm.toISOString(),
    });
    // Terceira rodada (NEGATIVA-3): apagados, em vez de virarem período e designação de um dia depois da desativação.
    expect(await db.notifyingUnit.count({ where: { unitId: futura.id } })).toBe(0);
    expect(await db.notifyingUnitResponsible.findUnique({ where: { id: tecnica.id } })).toBeNull();
    const [enfermeiro, medicaDepois] = await Promise.all([designacao('enfermeiro'), designacao('medica')]);
    expect([dia(enfermeiro.until), enfermeiro.revokedBy, enfermeiro.revokedAt?.toISOString()]).toEqual(['2026-06-17', usuario.gestora, desativadaEm.toISOString()]);
    expect([dia(medicaDepois.until), medicaDepois.revokedBy]).toEqual(['2026-03-10', usuario.vigilancia]);

    // Trilha: as ações da tela da negativa, com o motivo, na conta de quem desativou.
    expect(await trilha('vigilancia.notificante_encerrar', periodo.id)).toEqual([{ userId: usuario.gestora, entityType: 'NotifyingUnit', payloadHash: hash({ unidade: u.cnes, ate: '2026-06-17', motivo: MOTIVO }) }]);
    expect(await trilha('vigilancia.notificante_excluir', periodoFutura.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnit', payloadHash: hash({ unidade: futura.cnes, desde: '2026-07-01', ate: null, motivoFim: null, motivo: MOTIVO }) },
    ]);
    expect(await trilha('vigilancia.negativa_revogar', enfermeiro.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnitResponsible', payloadHash: hash({ unidade: u.id, usuario: usuario.enfermeiro, tipo: 'TITULAR', ate: '2026-06-17', motivo: MOTIVO }) },
    ]);
    expect(await trilha('vigilancia.negativa_designacao_excluir', tecnica.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnitResponsible', payloadHash: hash({ unidade: u.id, usuario: usuario.tecnica, tipo: 'SUBSTITUTO', desde: '2026-06-20', motivo: MOTIVO }) },
    ]);
    expect((await trilha('vigilancia.negativa_revogar', medica.id)).map((a) => a.userId)).toEqual([usuario.vigilancia]);

    // A SE 24 (14 a 20/06), a da desativação, continua notificante: o período alcança parte dela. Na própria semana, em
    // curso (as silenciosas anteriores seguem contando); na segunda seguinte, aguardando o prazo, e a SE 25 já é "não
    // notificante": a unidade sai das silenciosas.
    const grade = async (q: string) => (await t.http().get(`/api/vigilancia/negativas/grade?${q}`).set(auth('gestora')).expect(200)).body as Grade;
    const situacoes = (g: Grade) => g.linhas.find((l) => l.unidade.id === u.id)!.celulas.map((c) => [c.semana, c.situacao]);
    negativas.agora = () => desativadaEm;
    const naSemana = await grade('semanas=3&ate=202624');
    expect(situacoes(naSemana)).toEqual([
      ['202622', 'SEM_INFORMACAO'],
      ['202623', 'SEM_INFORMACAO'],
      ['202624', 'EM_CURSO'],
    ]);
    expect(naSemana.analise.silenciosas.map((s) => s.unitId)).toContain(u.id);
    negativas.agora = () => new Date('2026-06-22T13:00:00Z');
    const naSegunda = await grade('semanas=2&ate=202625');
    expect(situacoes(naSegunda)).toEqual([
      ['202624', 'AGUARDANDO'],
      ['202625', 'NAO_NOTIFICANTE'],
    ]);
    expect(naSegunda.analise.silenciosas.map((s) => s.unitId)).not.toContain(u.id);
    // Em 08/07/2026 (SE 27): a SE 24 ficou sem informação; as seguintes são "não notificante", fora das silenciosas e do
    // percentual, e sem o aviso de unidade inativa.
    negativas.agora = () => new Date('2026-07-08T15:00:00Z');
    const g = await grade('semanas=6&ate=202627');
    const linha = g.linhas.find((l) => l.unidade.id === u.id)!;
    expect(linha.ativa).toBe(false);
    expect(linha.celulas.map((c) => [c.semana, c.situacao])).toEqual([
      ['202622', 'SEM_INFORMACAO'],
      ['202623', 'SEM_INFORMACAO'],
      ['202624', 'SEM_INFORMACAO'],
      ['202625', 'NAO_NOTIFICANTE'],
      ['202626', 'NAO_NOTIFICANTE'],
      ['202627', 'NAO_NOTIFICANTE'],
    ]);
    expect(g.analise.silenciosas.map((s) => s.unitId)).not.toContain(u.id);
    expect(g.avisos.filter((a) => a.includes('UBS Rodada Dois'))).toEqual([]);
    // O ex-titular não tem mais a unidade para atestar.
    const minhas = (await t.http().get('/api/vigilancia/negativas/minhas').set(auth('enfermeiro')).expect(200)).body as { unidades: { unidade: { id: string } }[] };
    expect(minhas.unidades.map((x) => x.unidade.id)).not.toContain(u.id);

    // Reativar não reabre o período nem as designações (a vigilância abre um período novo se quiser): a lista avisa e a
    // unidade conta em "sem configuração" (terceira rodada, sur-7).
    admin.agora = () => new Date('2026-07-08T15:00:00Z');
    await t.http().patch(`/api/admin/units/${u.id}`).set(auth('gestora')).send({ active: true }).expect(200);
    expect(await db.notifyingUnit.count({ where: { unitId: u.id, until: null } })).toBe(0);
    expect(await db.notifyingUnitResponsible.count({ where: { unitId: u.id, until: null } })).toBe(0);
    const lista = (await t.http().get('/api/vigilancia/unidades-notificantes').set(auth('vig')).expect(200)).body as UnidadeNotificante[];
    expect(lista.find((x) => x.unidade.id === u.id)).toMatchObject({
      ativa: true,
      periodoAtual: null,
      periodos: [{ desde: '2026-01-01', ate: '2026-06-17', motivoFim: MOTIVO }],
      semConfiguracao: true,
      avisos: [AVISO_REATIVADA],
    });
    // Desativar de novo (sem nada aberto) não grava mais nada; nem a unidade já inativa.
    await t.http().patch(`/api/admin/units/${u.id}`).set(auth('gestora')).send({ active: false }).expect(200);
    await t.http().patch(`/api/admin/units/${u.id}`).set(auth('gestora')).send({ active: false }).expect(200);
    expect(
      await db.auditEntry.count({
        where: { action: { in: ['vigilancia.notificante_encerrar', 'vigilancia.negativa_revogar', 'vigilancia.notificante_excluir', 'vigilancia.negativa_designacao_excluir'] }, userId: usuario.gestora },
      }),
    ).toBe(4);
    expect(dia((await db.notifyingUnit.findUniqueOrThrow({ where: { id: periodo.id } })).until)).toBe('2026-06-17');
  });

  it('contingencia-mesmo-dia: o segundo acionamento do dia fecha o primeiro no próprio dia (fim >= início) e a situação usa o novo', async () => {
    const em = (instante: string) => {
      t.app.get(ContingenciaService).agora = () => new Date(instante);
      t.app.get(DiagramaService).agora = () => new Date(instante);
    };
    // Só o que este teste grava (a demonstração semeia plano e acionamento).
    await db.contingencyActionItem.deleteMany();
    await db.contingencyActivation.deleteMany();
    await db.contingencyInput.deleteMany();
    await db.contingencyPlan.deleteMany();
    em('2026-08-16T13:00:00Z');
    const plano = (await t.http().post('/api/vigilancia/contingencia/planos').set(auth('vig')).send({ modelo: 'MS_2025' }).expect(201)).body as { id: string };
    await t.http().post(`/api/vigilancia/contingencia/planos/${plano.id}/vigencia`).set(auth('vig')).send({ desde: '2026-01-04' }).expect(200);
    const acionar = async (estagio: string, justificativa: string) =>
      (await t.http().post('/api/vigilancia/contingencia/acionar').set(auth('vig')).send({ estagio, justificativa, nivel: 'MUNICIPIO', territorio: null }).expect(201)).body as {
        acionamento: { id: string; estagio: string; inicio: string; semanaInicio: string; fim: string | null };
        anteriorEncerrado: { id: string; fim: string } | null;
      };
    // Domingo, 16/08/2026 (SE 33), 10h em Brasília: mobilização.
    const mob = await acionar('MOBILIZACAO', 'Incidência acima da mediana há duas semanas seguidas.');
    // Segunda, 17/08, 10h: alerta. A mobilização, que começou ontem, termina na véspera (como antes).
    em('2026-08-17T13:00:00Z');
    const ale = await acionar('ALERTA', 'Curva acima do limite superior e casos graves em alta.');
    expect(ale.anteriorEncerrado).toEqual({ id: mob.acionamento.id, fim: '2026-08-16' });
    // Segunda, 17/08, 22h30 (já 18/08 em UTC): a vigilância aciona a epidemia no mesmo dia. O alerta, que começou
    // hoje, termina hoje: a véspera ficaria antes do início.
    em('2026-08-18T01:30:00Z');
    const justificativa = 'Óbitos em investigação e serviços de saúde sobrecarregados.';
    const epi = await acionar('EPIDEMIA', justificativa);
    expect(epi.anteriorEncerrado).toEqual({ id: ale.acionamento.id, fim: '2026-08-17' });
    expect(epi.acionamento).toMatchObject({ estagio: 'EPIDEMIA', inicio: '2026-08-17', semanaInicio: '202633', fim: null });

    const s = (await t.http().get('/api/vigilancia/contingencia').set(auth('vig')).expect(200)).body as SituacaoContingencia;
    expect(s.estagioAtual).toEqual({ chave: 'EPIDEMIA', nome: 'Situação de epidemia', desde: '2026-08-17', acionamentoId: epi.acionamento.id });
    expect(s.historico.map((h) => [h.estagio, h.inicio, h.semanaInicio, h.fim, h.semanaFim])).toEqual([
      ['EPIDEMIA', '2026-08-17', '202633', null, null],
      ['ALERTA', '2026-08-17', '202633', '2026-08-17', '202633'],
      ['MOBILIZACAO', '2026-08-16', '202633', '2026-08-16', '202633'],
    ]);
    for (const h of s.historico) if (h.fim) expect(h.fim >= h.inicio).toBe(true);
    // K2: a desmobilização conta as SE completas desde o início do acionamento em vigor (nenhuma ainda): mantém.
    expect(s.avaliacao).toMatchObject({ sugerido: 'EPIDEMIA', desmobilizacao: { sugerida: false } });
    // O checklist é o do acionamento novo; o do alerta, encerrado, não muda mais.
    const itens = await db.contingencyActionItem.findMany({ where: { activationId: epi.acionamento.id }, select: { id: true } });
    expect(s.checklist.map((a) => a.id).sort()).toEqual(itens.map((i) => i.id).sort());
    expect(itens).toHaveLength(acoesDoEstagio(PLANO_MODELO_MS_2025, 'EPIDEMIA').length);
    const doAlerta = await db.contingencyActionItem.findFirstOrThrow({ where: { activationId: ale.acionamento.id } });
    await t.http().patch(`/api/vigilancia/contingencia/acoes/${doAlerta.id}`).set(auth('vig')).send({ status: 'FEITA' }).expect(409);
    // Um só aberto (o índice contingency_activations_aberta), e nenhum com o fim antes do início.
    expect(await db.contingencyActivation.count({ where: { endedOn: null } })).toBe(1);
    const gravados = await db.contingencyActivation.findMany({ where: { endedOn: { not: null } }, select: { startedOn: true, endedOn: true, startedWeek: true, endedWeek: true } });
    expect(gravados.every((a) => a.endedOn!.getTime() >= a.startedOn.getTime() && a.endedWeek! >= a.startedWeek)).toBe(true);
    // A trilha guarda o fim real do encerrado.
    expect(await trilha('vigilancia.contingencia_acionada', epi.acionamento.id)).toEqual([
      {
        userId: usuario.vigilancia,
        entityType: 'ContingencyActivation',
        payloadHash: hash({
          plano: plano.id,
          territorio: { nivel: 'MUNICIPIO', id: null },
          estagio: 'EPIDEMIA',
          justificativa,
          ato: null,
          encerrados: [{ id: ale.acionamento.id, estagio: 'ALERTA', fim: '2026-08-17' }],
          acoes: acoesDoEstagio(PLANO_MODELO_MS_2025, 'EPIDEMIA').length,
        }),
      },
    ]);
  });

  it('surto-leitura-sigilosa: detalhe, espelho e planilha com caso sigiloso sem máscara ficam na trilha; sem caso sigiloso aberto, não', async () => {
    let seq = 0;
    const hoje = () => localDateString(new Date(), TZ);
    const diasAtras = (n: number) => localDateString(new Date(Date.now() - n * DIA), TZ);
    const novoPaciente = async (nome: string, sex: 'M' | 'F') => {
      seq++;
      const body = {
        name: nome,
        birthDate: `${1970 + seq}-0${1 + (seq % 9)}-1${seq % 8}`,
        sex,
        cpf: completeCpf(String(272900100 + seq)),
        cns: cnsFromBase(String(27290000100 + seq)),
        motherName: `Mae de ${nome}`,
        phone: '(11) 97777-2729',
        address: { cep: '01001000', street: 'Rua da Rodada Dois', number: String(seq), district: 'Centro', city: 'São Paulo', uf: 'SP', ibgeCode: '3550308' },
        confirmNotDuplicate: true,
      };
      return (await t.http().post('/api/patients').set(auth('recepcao')).send(body).expect(201)).body.id as string;
    };
    const notificar = async (patientId: string, conditionKey: string) =>
      (
        (
          await t
            .http()
            .post('/api/vigilancia/notificacoes')
            .set(auth('medica'))
            .send({ patientId, conditionKey, knownAt: new Date(Date.now() - DIA).toISOString(), symptomsOnset: diasAtras(2) })
            .expect(201)
        ).body as { id: string }
      ).id;
    const importacao = (
      await db.officialImport.create({
        data: { system: 'SINAN_NET', status: 'APLICADA', fileName: 'rodada2.zip', sha256: 'e'.repeat(64), sizeBytes: 1, createdBy: usuario.vigilancia!, appliedBy: usuario.vigilancia!, appliedAt: new Date() },
      })
    ).id;
    const registroSigiloso = (numero: string, cnes: string, nome: string) =>
      db.officialRecord.create({
        data: {
          system: 'SINAN_NET',
          type: 'INDIVIDUAL',
          naturalKey: `rodada2-${numero}`,
          number: numero,
          notifiedOn: new Date(`${diasAtras(3)}T00:00:00Z`),
          municipalityIbge: '355030',
          unitCnes: cnes,
          agravo: 'A539',
          groupKey: 'sifilis',
          residenceIbge: '355030',
          situation: 'CONFIRMADO',
          sensitive: true,
          patientName: nome,
          sex: 'F',
          birthDate: new Date('1990-05-05T00:00:00Z'),
          contentHash: '0'.repeat(64),
          firstImportId: importacao,
          lastImportId: importacao,
          lastSeenAt: new Date(),
        },
        select: { id: true },
      });
    const base = { notificadoEm: hoje(), conhecidoEm: new Date(Date.now() - H).toISOString(), primeirosSintomasEm: diasAtras(3), casos: 4, localInicial: '2', unitId: U.hosp!.id };
    const detalhe = async (id: string, k: string) => (await t.http().get(`/api/vigilancia/surtos/${id}`).set(auth(k)).expect(200)).body as Detalhe;
    const espelho = async (id: string, k: string) => (await t.http().get(`/api/vigilancia/surtos/${id}/espelho`).set(auth(k)).expect(200)).body as Detalhe['espelho'];
    const incluir = async (id: string, corpo: object) => ((await t.http().post(`/api/vigilancia/surtos/${id}/casos`).set(auth('vig')).send(corpo).expect(201)).body as { caso: Caso }).caso;
    const leituras = (surtoId: string) => trilha('vigilancia.surto_ver_sensivel', surtoId);
    const leitura = (quem: string, s: { id: string; numero: string }, rota: string, casos: string[], notificacoes: string[], registros: string[]) => ({
      userId: usuario[quem],
      entityType: 'Outbreak',
      payloadHash: hash({ numero: s.numero, rota, casos, notificacoes, registros }),
    });

    // Surto sem caso sigiloso: a leitura não vai para a trilha.
    const coqueluche = await notificar(await novoPaciente('Pedro Coqueluche Rodada', 'M'), 'coqueluche');
    const comum = (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('vig'))
        .send({ ...base, casosIndicados: [{ notificationId: coqueluche }], categoria: 'DA_LISTA', grupo: 'coqueluche' })
        .expect(201)
    ).body as Detalhe;
    await incluir(comum.id, { linha: { iniciais: 'ABC', sexo: 'F', idade: '8 anos' } });
    expect((await detalhe(comum.id, 'vig')).planilha.map((c) => c.restrito)).toEqual([false, false]);
    await espelho(comum.id, 'vig');
    await detalhe(comum.id, 'nucleo');
    expect(await leituras(comum.id)).toEqual([]);

    // Surto de sífilis no hospital: a notificação e um registro sigilosos da UBS (o núcleo do hospital não abre) e um
    // registro sigiloso do hospital (o núcleo abre).
    const sifilis = await notificar(await novoPaciente('Joana Sifilis Rodada', 'F'), 'sifilis');
    const daUbs = await registroSigiloso('8290001', U.ubs!.cnes, 'Rosa Maria Lima');
    const doHospital = await registroSigiloso('8290002', U.hosp!.cnes, 'Tereza Souza Prado');
    const criado = (
      await t
        .http()
        .post('/api/vigilancia/surtos')
        .set(auth('vig'))
        .send({ ...base, casosIndicados: [{ notificationId: sifilis }], categoria: 'DA_LISTA', grupo: 'sifilis' })
        .expect(201)
    ).body as Detalhe;
    const s = { id: criado.id, numero: criado.numero };
    const c1 = criado.planilha[0]!;
    expect(c1).toMatchObject({ restrito: false, iniciais: 'JSR' });
    const esperado = [leitura('vigilancia', s, 'POST /vigilancia/surtos', [c1.id], [sifilis], [])];
    expect(await leituras(s.id)).toEqual(esperado);
    // A resposta da inclusão mostra só a linha incluída: a trilha é só dela. A linha manual não vai para a trilha.
    const c2 = await incluir(s.id, { officialRecordId: daUbs.id });
    esperado.push(leitura('vigilancia', s, 'POST /vigilancia/surtos/:id/casos', [c2.id], [], [daUbs.id]));
    const c3 = await incluir(s.id, { officialRecordId: doHospital.id });
    esperado.push(leitura('vigilancia', s, 'POST /vigilancia/surtos/:id/casos', [c3.id], [], [doHospital.id]));
    const c4 = await incluir(s.id, { linha: { iniciais: 'XYZ', sexo: 'M', idade: '30 anos' } });
    expect([c2.restrito, c2.iniciais, c3.restrito, c3.iniciais, c4.restrito]).toEqual([false, 'RML', false, 'TSP', false]);
    expect(await leituras(s.id)).toEqual(esperado);

    // Detalhe e espelho da vigilância municipal: os três casos sigilosos, sem máscara.
    expect((await detalhe(s.id, 'vig')).planilha.map((c) => [c.numero, c.restrito, c.iniciais])).toEqual([
      [1, false, 'JSR'],
      [2, false, 'RML'],
      [3, false, 'TSP'],
      [4, false, 'XYZ'],
    ]);
    esperado.push(leitura('vigilancia', s, 'GET /vigilancia/surtos/:id', [c1.id, c2.id, c3.id], [sifilis], [daUbs.id, doHospital.id]));
    expect((await espelho(s.id, 'vig')).planilha.map((l) => l.NM_CASO)).toEqual(['JSR', 'RML', 'TSP', 'XYZ']);
    esperado.push(leitura('vigilancia', s, 'GET /vigilancia/surtos/:id/espelho', [c1.id, c2.id, c3.id], [sifilis], [daUbs.id, doHospital.id]));
    expect(await leituras(s.id)).toEqual(esperado);

    // O núcleo do hospital: os da UBS vêm mascarados (fora da trilha); o do hospital, aberto, entra.
    expect((await detalhe(s.id, 'nucleo')).planilha.map((c) => [c.numero, c.restrito, c.iniciais])).toEqual([
      [1, true, null],
      [2, true, null],
      [3, false, 'TSP'],
      [4, false, 'XYZ'],
    ]);
    esperado.push(leitura('nucleo', s, 'GET /vigilancia/surtos/:id', [c3.id], [], [doHospital.id]));
    expect((await espelho(s.id, 'nucleo')).planilha.map((l) => l.NM_CASO)).toEqual([null, null, 'TSP', 'XYZ']);
    esperado.push(leitura('nucleo', s, 'GET /vigilancia/surtos/:id/espelho', [c3.id], [], [doHospital.id]));
    // As ações que devolvem o detalhe também (aqui, a comunicação do núcleo à SMS).
    await t
      .http()
      .post(`/api/vigilancia/surtos/${s.id}/comunicacoes`)
      .set(auth('nucleo'))
      .send({ alvo: 'SMS', canal: 'TELEFONE', contraparte: 'Plantão da vigilância', em: new Date(Date.now() - 60_000).toISOString() })
      .expect(201);
    esperado.push(leitura('nucleo', s, 'POST /vigilancia/surtos/:id/comunicacoes', [c3.id], [], [doHospital.id]));
    expect(await leituras(s.id)).toEqual(esperado);

    // Sem o caso do hospital, o núcleo só vê casos mascarados: a leitura não vai para a trilha.
    await t.http().delete(`/api/vigilancia/surtos/${s.id}/casos/${c3.id}`).set(auth('vig')).expect(200);
    expect((await detalhe(s.id, 'nucleo')).planilha.map((c) => c.restrito)).toEqual([true, true, false]);
    await espelho(s.id, 'nucleo');
    expect(await leituras(s.id)).toEqual(esperado);
  });
});
