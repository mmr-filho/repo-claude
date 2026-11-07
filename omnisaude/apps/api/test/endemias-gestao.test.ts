import { randomUUID } from 'node:crypto';
import {
  areaM2,
  caixaDe,
  centroDe,
  cicloBimestral,
  completeCpf,
  localDateString,
  metrosPorGrau,
  normalizarArea,
  SITUACAO_INFO,
  totaisDepositos,
  turnoDaHora,
  type AtividadeVetorial,
  type Depositos,
  type Posicao,
  type SituacaoVisita,
} from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

// Fuso do município da demonstração (UTC-3, sem horário de verão).
const TZ = 'America/Sao_Paulo';
const local = (dia: string, hora: string) => new Date(`${dia}T${hora}:00-03:00`);
const diaHa = (n: number) => localDateString(new Date(Date.now() - n * 86_400_000), TZ);

// Quarteirões de 80 m longe da demonstração e dos outros testes.
const O: Posicao = [-48.6, -11.4];
const mpg = metrosPorGrau(O[1]);
const desloca = (p: Posicao, lesteM: number, norteM: number): Posicao => [p[0] + lesteM / mpg.lng, p[1] + norteM / mpg.lat];

interface Pendencia {
  imovelId: string;
  situacao: SituacaoVisita;
  ultimaEm: string;
  tentativas: number;
  fechados: number;
  recusas: number;
  naOrdem: boolean;
  ausenciaDocumentada: boolean;
}

describe.runIf(enabled)('VIG-3a gestão: produção, índices, pendências e titular da zona', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let vig = '';
  let supervisora = '';
  let aceId = '';
  let supervisoraId = '';
  let vigUnitId = '';
  let produtoId = '';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const cicloAtual = () => cicloBimestral(diaHa(0)).chave;

  const novaLocalidade = async (code: string) => (await db.locality.create({ data: { code, name: `Gestão ${code}` } })).id;
  async function novoQuarteirao(localityId: string, numero: string, lesteM: number) {
    const a = desloca(O, lesteM - 40, -40);
    const b = desloca(O, lesteM + 40, 40);
    const area = normalizarArea({ type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] });
    const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
    const [centerLng, centerLat] = centroDe(area);
    return (await db.block.create({ data: { localityId, number: numero, geometry: area as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng, areaM2: areaM2(area), source: 'EDITOR' } })).id;
  }
  const novaCasa = async (rua: string, blockId: string | null = null, tipo = '01') => (await db.household.create({ data: { street: rua, number: '1', propertyType: tipo, blockId } })).id;

  /** Grava a visita direto no banco, com as colunas que a sincronização preenche. */
  async function visita(householdId: string, quando: Date, v: { atividade: AtividadeVetorial; situacao: SituacaoVisita; depositos?: Depositos; ciclo: string; blockId?: string | null; userId?: string }) {
    const pendente = SITUACAO_INFO[v.situacao].pendencia;
    const tot = totaisDepositos(pendente ? null : v.depositos);
    const hora = Number(quando.toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }));
    await db.vectorVisit.create({
      data: {
        clientId: randomUUID(),
        userId: v.userId ?? aceId,
        unitId: vigUnitId,
        cbo: '515140',
        householdId,
        blockId: v.blockId ?? null,
        propertyType: '01',
        activity: v.atividade,
        situation: v.situacao,
        cycle: v.ciclo,
        visitedAt: quando,
        turno: turnoDaHora(hora),
        deposits: pendente || !v.depositos ? undefined : (v.depositos as object),
        depositsInspected: tot.inspecionados,
        depositsPositive: tot.comFoco,
        depositsEliminated: tot.eliminados,
        depositsTreated: tot.tratados,
      },
    });
  }

  const producao = async (de: string, ate = de) => (await t.http().get(`/api/endemias/producao?de=${de}&ate=${ate}`).set(auth(vig)).expect(200)).body;
  const pendencias = async () => (await t.http().get('/api/endemias/pendencias').set(auth(supervisora)).expect(200)).body as Pendencia[];

  beforeAll(async () => {
    t = await startTestApp('endemiasgestao');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    supervisora = await t.login('supervisora', 'Vigilância em Saúde', 'SUPERVISOR_ENDEMIAS');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    aceId = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000016') } })).id;
    supervisoraId = (await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000017') } })).id;
    vigUnitId = (await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } })).id;
    produtoId = (await db.product.findFirstOrThrow({ where: { vectorControl: 'LARVICIDA' } })).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  // ─── Produção e índices (contrato 12) ─────────────────────────────────────

  it('índices só do levantamento (LI e LI+T): o PE com foco fica na positividade, não no IIP', async () => {
    const localidade = await novaLocalidade('71');
    const q = await novoQuarteirao(localidade, '1', 0);
    const dia = '2025-03-10';
    const ciclo = cicloBimestral(dia).chave;
    const sem: Depositos = { A2: { inspecionados: 2, comFoco: 0, eliminados: 0, tratados: 0 } };
    for (const rua of ['Rua A1', 'Rua A2', 'Rua A3']) await visita(await novaCasa(rua, q), local(dia, '09:00'), { atividade: 'LI_T', situacao: 'TRABALHADO', depositos: sem, ciclo, blockId: q });
    const pe = await novaCasa('Av. da Borracharia', q, '04');
    await visita(pe, local(dia, '10:00'), { atividade: 'PE', situacao: 'TRABALHADO', depositos: { C: { inspecionados: 2, comFoco: 1, eliminados: 1, tratados: 0 } }, ciclo, blockId: q });
    await visita(await novaCasa('Rua Fechada', q), local(dia, '11:00'), { atividade: 'LI_T', situacao: 'FECHADO', ciclo, blockId: q });

    const p = await producao(dia);
    // O resumo conta todas as atividades, como o boletim; "imóveis com foco" é em qualquer atividade.
    expect(p.total).toMatchObject({ visitas: 5, trabalhados: 4, fechados: 1, imoveisComFoco: 1, depositosInspecionados: 8, depositosComFoco: 1 });
    // Antes: IIP 25% (risco) com o PE na base.
    expect(p.total.indices).toMatchObject({ imoveisInspecionados: 3, imoveisComFoco: 0, depositosInspecionados: 6, depositosComFoco: 0, iip: 0, ib: 0, ir: 0, classe: 'SATISFATORIO' });
    expect(p.total.positividade).toEqual([{ atividade: 'PE', label: 'Ponto estratégico', imoveisInspecionados: 1, imoveisComFoco: 1, percentual: 100 }]);
    expect(p.localidades).toEqual([{ id: localidade, codigo: '71', nome: 'Gestão 71', visitas: 5, indices: p.total.indices }]);
    expect(p.agentes).toMatchObject([{ id: aceId, nome: 'Rafael Souza Agente de Endemias', visitas: 5, trabalhados: 4 }]);
  });

  it('a visita de bloqueio sem foco depois não apaga o foco achado no LI+T; cada agente com o seu resumo', async () => {
    const dia = '2025-03-12';
    const ciclo = cicloBimestral(dia).chave;
    const h = await novaCasa('Rua do Foco');
    await visita(h, local(dia, '09:00'), { atividade: 'LI_T', situacao: 'TRABALHADO', depositos: { A2: { inspecionados: 2, comFoco: 1, eliminados: 1, tratados: 0 } }, ciclo });
    await visita(h, local(dia, '15:00'), { atividade: 'BLOQUEIO', situacao: 'TRABALHADO', depositos: { A2: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 0 } }, ciclo, userId: supervisoraId });

    const p = await producao(dia);
    expect(p.total).toMatchObject({ visitas: 2, trabalhados: 2, imoveisComFoco: 1 });
    // Antes: imoveisComFoco 0 e IIP 0% (satisfatório) no mesmo cartão que dizia 1 imóvel com foco.
    expect(p.total.indices).toMatchObject({ imoveisInspecionados: 1, imoveisComFoco: 1, depositosInspecionados: 2, depositosComFoco: 1, iip: 100, ib: 100, ir: 50, classe: 'RISCO' });
    expect(p.total.indices.itr).toMatchObject({ A2: 100, A1: 0 });
    expect(p.total.positividade).toEqual([{ atividade: 'BLOQUEIO', label: 'Bloqueio de transmissão', imoveisInspecionados: 1, imoveisComFoco: 0, percentual: 0 }]);
    const porAgente = Object.fromEntries(p.agentes.map((a: { id: string }) => [a.id, a]));
    expect(porAgente[aceId]).toMatchObject({ visitas: 1, trabalhados: 1, imoveisComFoco: 1, depositosComFoco: 1 });
    expect(porAgente[supervisoraId]).toMatchObject({ visitas: 1, trabalhados: 1, imoveisComFoco: 0, depositosComFoco: 0 });
    // Período com os dois dias: 4 imóveis no levantamento, 1 com foco.
    expect((await producao('2025-03-10', '2025-03-12')).total.indices).toMatchObject({ imoveisInspecionados: 4, imoveisComFoco: 1, iip: 25, classe: 'RISCO' });
  });

  it('mais de 50 mil visitas no período: responde sem cair no limite de parâmetros e sem cortar a conta', async () => {
    const localidade = await novaLocalidade('72');
    const q = await novoQuarteirao(localidade, '1', 500);
    const dia = '2025-05-20';
    const ciclo = cicloBimestral(dia).chave;
    // 50.500 imóveis com LI+T às 9h (1 em cada 100 com foco, que recebe bloqueio sem foco às 15h); larvicida em 1 de
    // cada 10 visitas do levantamento (0,5 g) e uma baixa cancelada em 1 de cada 1.000 (não conta).
    await db.$executeRaw`
      WITH casas AS (
        INSERT INTO households (id, street, number, property_type, block_id, updated_at)
        SELECT gen_random_uuid(), 'Rua do Volume', g::text, '01', ${q}::uuid, now() FROM generate_series(1, 50500) g
        RETURNING id, number::int AS n
      ),
      li AS (
        INSERT INTO vector_visits (id, client_id, user_id, unit_id, cbo, household_id, block_id, property_type, activity, situation, cycle, visited_at, turno, deposits, deposits_inspected, deposits_positive)
        SELECT gen_random_uuid(), gen_random_uuid(), ${aceId}::uuid, ${vigUnitId}::uuid, '515140', c.id, ${q}::uuid, '01', 'LI_T', 'TRABALHADO', ${ciclo}, ${`${dia} 12:00:00`}::timestamp, 1,
          jsonb_build_object('A2', jsonb_build_object('inspecionados', 1, 'comFoco', (c.n % 100 = 0)::int, 'eliminados', 0, 'tratados', 0)), 1, (c.n % 100 = 0)::int
        FROM casas c
        RETURNING id, household_id
      ),
      blq AS (
        INSERT INTO vector_visits (id, client_id, user_id, unit_id, cbo, household_id, block_id, property_type, activity, situation, cycle, visited_at, turno, deposits, deposits_inspected, deposits_positive)
        SELECT gen_random_uuid(), gen_random_uuid(), ${aceId}::uuid, ${vigUnitId}::uuid, '515140', c.id, ${q}::uuid, '01', 'BLOQUEIO', 'TRABALHADO', ${ciclo}, ${`${dia} 18:00:00`}::timestamp, 2,
          '{"A2": {"inspecionados": 1, "comFoco": 0, "eliminados": 0, "tratados": 0}}'::jsonb, 1, 0
        FROM casas c WHERE c.n % 100 = 0
        RETURNING id
      )
      INSERT INTO vector_treatments (id, visit_id, seq, product_id, quantity, deposits, stock_status)
      SELECT gen_random_uuid(), li.id, 1, ${produtoId}::uuid, CASE WHEN c.n % 10 = 0 THEN 0.5 ELSE 100 END, 1, (CASE WHEN c.n % 10 = 0 THEN 'BAIXADO' ELSE 'CANCELADO' END)::"TreatmentStockStatus"
      FROM li JOIN casas c ON c.id = li.household_id
      WHERE c.n % 10 = 0 OR c.n % 1000 = 1`;
    expect(await db.vectorVisit.count({ where: { cycle: ciclo } })).toBe(51_005);

    const p = await producao(dia);
    expect(p.total).toMatchObject({ visitas: 51_005, trabalhados: 51_005, imoveisComFoco: 505, depositosInspecionados: 51_005, depositosComFoco: 505 });
    // 505 com foco em 50.500 imóveis: exatamente 1%, alerta; o bloqueio depois não apaga nenhum desses focos.
    expect(p.total.indices).toMatchObject({ imoveisInspecionados: 50_500, imoveisComFoco: 505, depositosInspecionados: 50_500, depositosComFoco: 505, iip: 1, ib: 1, ir: 1, classe: 'ALERTA' });
    expect(p.total.indices.itr.A2).toBe(100);
    expect(p.total.positividade).toEqual([{ atividade: 'BLOQUEIO', label: 'Bloqueio de transmissão', imoveisInspecionados: 505, imoveisComFoco: 0, percentual: 0 }]);
    // 5.050 baixas de 0,5 g; as 51 canceladas ficam de fora.
    expect(p.total.larvicida).toHaveLength(1);
    expect(p.total.larvicida[0].quantidade).toBe(2525);
    expect(p.agentes).toHaveLength(1);
    expect(p.agentes[0]).toMatchObject({ id: aceId, visitas: 51_005 });
    expect(p.agentes[0].larvicida[0].quantidade).toBe(2525);
    expect(p.localidades).toMatchObject([{ id: localidade, visitas: 51_005, indices: { imoveisInspecionados: 50_500, imoveisComFoco: 505 } }]);
  });

  // ─── Pendências (contrato 11) ─────────────────────────────────────────────

  const casas: Record<string, string> = {};

  it('ausência documentada só com duas visitas de imóvel fechado em dias e turnos diferentes em até 10 dias; recusa à parte', async () => {
    const ciclo = cicloAtual();
    const reg = async (chave: string, ...vs: [number, string, SituacaoVisita][]) => {
      casas[chave] = await novaCasa(`Rua ${chave}`);
      for (const [n, hora, situacao] of vs) await visita(casas[chave]!, local(diaHa(n), hora), { atividade: 'LI_T', situacao, ciclo, depositos: situacao === 'TRABALHADO' ? {} : undefined });
    };
    await reg('recusa2', [6, '09:00', 'RECUSADO'], [4, '15:00', 'RECUSADO']);
    await reg('recusaFechado', [6, '09:30', 'RECUSADO'], [4, '15:30', 'FECHADO']);
    await reg('fechado2', [6, '09:00', 'FECHADO'], [4, '15:00', 'FECHADO']);
    await reg('mesmoTurno', [6, '09:00', 'FECHADO'], [4, '10:00', 'FECHADO']);
    await reg('onzeDias', [14, '09:00', 'FECHADO'], [3, '15:00', 'FECHADO']);
    await reg('dezDias', [13, '09:00', 'FECHADO'], [3, '15:00', 'FECHADO']);
    await reg('depoisRecusou', [7, '09:00', 'FECHADO'], [5, '15:00', 'FECHADO'], [2, '10:00', 'RECUSADO']);
    await reg('trabalhadoNoMeio', [8, '09:00', 'FECHADO'], [7, '10:00', 'TRABALHADO'], [5, '15:00', 'FECHADO']);
    await reg('abandonado', [3, '11:00', 'ABANDONADO']);
    await reg('recuperado', [6, '09:00', 'FECHADO'], [2, '16:00', 'TRABALHADO']);

    const lista = await pendencias();
    const de = (chave: string) => lista.find((p) => p.imovelId === casas[chave]);
    // Antes: duas recusas (e recusa + fechado) viravam "ausência documentada".
    expect(de('recusa2')).toMatchObject({ situacao: 'RECUSADO', tentativas: 2, recusas: 2, fechados: 0, ausenciaDocumentada: false });
    expect(de('recusaFechado')).toMatchObject({ situacao: 'FECHADO', tentativas: 2, recusas: 1, fechados: 1, ausenciaDocumentada: false });
    expect(de('fechado2')).toMatchObject({ situacao: 'FECHADO', tentativas: 2, recusas: 0, fechados: 2, naOrdem: false, ausenciaDocumentada: true });
    expect(de('mesmoTurno')).toMatchObject({ fechados: 2, ausenciaDocumentada: false });
    expect(de('onzeDias')).toMatchObject({ fechados: 2, ausenciaDocumentada: false });
    expect(de('dezDias')).toMatchObject({ fechados: 2, ausenciaDocumentada: true });
    // Achado alguém que recusou depois, a hipótese passa a ser a recusa.
    expect(de('depoisRecusou')).toMatchObject({ situacao: 'RECUSADO', tentativas: 3, fechados: 2, recusas: 1, ausenciaDocumentada: false });
    // As tentativas contam desde a última visita trabalhada.
    expect(de('trabalhadoNoMeio')).toMatchObject({ situacao: 'FECHADO', tentativas: 1, fechados: 1, ausenciaDocumentada: false });
    expect(de('abandonado')).toMatchObject({ situacao: 'ABANDONADO', tentativas: 1, fechados: 0, recusas: 0, ausenciaDocumentada: false });
    expect(de('recuperado')).toBeUndefined();
    expect(de('fechado2')!.ultimaEm).toBe(local(diaHa(4), '15:00').toISOString());
    // A mais recente primeiro.
    expect(lista.map((p) => p.ultimaEm)).toEqual([...lista.map((p) => p.ultimaEm)].sort().reverse());
  });

  it('com mais de 20 mil visitas no ciclo, a pendência nova aparece e o imóvel recuperado sai da lista', async () => {
    const ciclo = cicloAtual();
    const y = await novaCasa('Rua Y');
    const x = await novaCasa('Rua X');
    const massa = await novaCasa('Rua da Massa');
    await visita(y, local(diaHa(9), '08:00'), { atividade: 'LI_T', situacao: 'FECHADO', ciclo });
    expect((await pendencias()).find((p) => p.imovelId === y)).toMatchObject({ situacao: 'FECHADO', tentativas: 1 });
    await db.$executeRaw`
      INSERT INTO vector_visits (id, client_id, user_id, unit_id, cbo, household_id, property_type, activity, situation, cycle, visited_at, turno)
      SELECT gen_random_uuid(), gen_random_uuid(), ${aceId}::uuid, ${vigUnitId}::uuid, '515140', ${massa}::uuid, '01', 'LI_T', 'TRABALHADO', ${ciclo},
        ${local(diaHa(8), '12:00').toISOString()}::timestamp + g * interval '1 millisecond', 2
      FROM generate_series(1, 20000) g`;
    await visita(y, local(diaHa(1), '10:00'), { atividade: 'LI_T', situacao: 'TRABALHADO', ciclo, depositos: { A2: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 0 } } });
    await visita(x, local(diaHa(1), '15:00'), { atividade: 'LI_T', situacao: 'FECHADO', ciclo });

    const lista = await pendencias();
    // Antes: a consulta pegava as 20.000 visitas mais antigas, X sumia e Y continuava pendente.
    expect(lista.find((p) => p.imovelId === x)).toMatchObject({ situacao: 'FECHADO', tentativas: 1, fechados: 1 });
    expect(lista.find((p) => p.imovelId === y)).toBeUndefined();
    expect(lista.find((p) => p.imovelId === massa)).toBeUndefined();
    expect(lista.find((p) => p.imovelId === casas.recusa2)).toMatchObject({ situacao: 'RECUSADO', recusas: 2 });
  });

  it('a lista traz no máximo 2.000 imóveis, os de última visita mais recente primeiro', async () => {
    const ciclo = cicloAtual();
    const agora = new Date();
    await db.$executeRaw`
      WITH casas AS (
        INSERT INTO households (id, street, number, property_type, updated_at)
        SELECT gen_random_uuid(), 'Rua das Pendências', g::text, '01', now() FROM generate_series(1, 2100) g
        RETURNING id, number::int AS n
      )
      INSERT INTO vector_visits (id, client_id, user_id, unit_id, cbo, household_id, property_type, activity, situation, cycle, visited_at, turno)
      SELECT gen_random_uuid(), gen_random_uuid(), ${aceId}::uuid, ${vigUnitId}::uuid, '515140', c.id, '01', 'LI_T', 'FECHADO', ${ciclo},
        ${agora.toISOString()}::timestamp - interval '1 hour' - c.n * interval '1 second', 1
      FROM casas c`;
    const novas = await db.household.findMany({ where: { street: 'Rua das Pendências' }, select: { id: true, number: true } });
    const numero = new Map(novas.map((h) => [h.id, Number(h.number)]));

    const lista = await pendencias();
    expect(lista).toHaveLength(2000);
    // São as 2.000 mais recentes (números 1 a 2.000), em ordem; as 100 mais antigas e as pendências de antes ficam de fora.
    expect(lista.every((p) => numero.has(p.imovelId))).toBe(true);
    expect(lista.map((p) => numero.get(p.imovelId))).toEqual(Array.from({ length: 2000 }, (_, k) => k + 1));
  });

  // ─── Titular da zona (contrato 8) ─────────────────────────────────────────

  it('o titular só é conferido quando muda: o atual sem lotação ativa não trava a edição da zona', async () => {
    let n = 0;
    const novoAgente = async () => {
      n++;
      const u = await db.user.create({ data: { cpf: completeCpf(String(791000000 + n)), name: `Agente Gestão ${n}`, passwordHash: 'x' } });
      await db.userAssignment.create({ data: { userId: u.id, unitId: vigUnitId, role: 'ACE', cbo: '515140' } });
      return u.id;
    };
    const transferido = await novoAgente();
    const inativo = await novoAgente();
    const salvar = (id: string | null, corpo: Record<string, unknown>) =>
      (id ? t.http().put(`/api/endemias/zonas/${id}`) : t.http().post('/api/endemias/zonas')).set(auth(supervisora)).send({ quarteiroes: [], ...corpo });

    const zona = (await salvar(null, { nome: 'Zona do Transferido', aceId: transferido }).expect(201)).body.id as string;
    // O agente é transferido (lotação encerrada): continua titular até a supervisão trocar.
    await db.userAssignment.updateMany({ where: { userId: transferido }, data: { active: false } });
    await salvar(zona, { nome: 'Zona do Transferido (centro)', aceId: transferido }).expect(200);
    expect((await db.vectorZone.findUniqueOrThrow({ where: { id: zona } })).name).toBe('Zona do Transferido (centro)');
    // Usuário desativado, mesmo com a lotação ativa, não vira titular novo.
    await db.user.update({ where: { id: inativo }, data: { active: false } });
    const recusa = await salvar(zona, { nome: 'Zona do Transferido (centro)', aceId: inativo }).expect(400);
    expect(recusa.body.message).toMatch(/lotação ativa/);
    await salvar(null, { nome: 'Zona Nova', aceId: inativo }).expect(400);
    // Deixar sem titular sempre pode; voltar o transferido já é troca e é conferida.
    await salvar(zona, { nome: 'Zona do Transferido (centro)', aceId: null }).expect(200);
    await salvar(zona, { nome: 'Zona do Transferido (centro)', aceId: transferido }).expect(400);
    await salvar(null, { nome: 'Outra Zona', aceId: transferido }).expect(400);
    // Agente apto continua aceito.
    await salvar(zona, { nome: 'Zona do Transferido (centro)', aceId }).expect(200);
    expect((await db.vectorZone.findUniqueOrThrow({ where: { id: zona } })).aceId).toBe(aceId);
  });
});
