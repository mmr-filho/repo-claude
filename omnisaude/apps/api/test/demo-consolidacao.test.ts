import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { applyMigrations, createMasterClient, demoFixtures, envCredentials, seedDemo } from '@omnisaude/database';
import type {
  ListaDivergentes,
  ListaSoOmnisaude,
  ListaSugestoesVinculo,
  ListaBairrosSemCorrespondencia,
  RespostaDiagrama,
  RespostaGradeNegativa,
  RespostaMinhasNegativas,
  RespostaSugestoesSurto,
  ResumoConciliacao,
  SituacaoContingencia,
  SurtoResumo,
} from '@omnisaude/shared';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContingenciaService } from '../src/modules/vigilancia/contingencia.service';
import { DiagramaService } from '../src/modules/vigilancia/diagrama.service';
import { NegativaService } from '../src/modules/vigilancia/negativa.service';
import { SurtoService } from '../src/modules/vigilancia/surto.service';
import { pgAvailable, TEST_PG } from './harness';

/**
 * Carga de demonstração da semana 27 (VIG-1c) lida pela API: a carga roda com a malha e a consolidação (como a linha
 * de comando), num dia fixo (quarta-feira, 04/11/2026, SE 44), e os serviços ficam no mesmo relógio. Confere o que a
 * demonstração promete: sugestão de MOBILIZAÇÃO, unidade silenciosa, sugestão de surto, surto de DTA aberto e as
 * listas da conciliação.
 */
const enabled = await pgAvailable();
const AGORA = new Date('2026-11-04T15:00:00Z');
const SUFIXO = (process.env.OMNI_TEST_SUFFIX ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const chave = `democonsolidacao${SUFIXO}`;
const SLUG = `t-${chave}`.slice(0, 40);
const MASTER = `omni_test_master_${chave}`;
const TENANT = `tenant_db_${SLUG.replace(/-/g, '_')}`;

describe.runIf(enabled)('Demonstração da semana 27: consolidação, diagrama, contingência, surto e negativa', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  const tk: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const unidade = (key: string) => demoFixtures.UNITS.find((u) => u.key === key)!;

  async function login(staffKey: string, unitName: string, role: string) {
    const staff = demoFixtures.STAFF.find((s) => s.key === staffKey)!;
    const res = await http().post('/api/auth/login').send({ tenant: SLUG, cpf: staff.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200);
    const a = (res.body.assignments as { unitName: string; unitId: string; role: string }[]).find((x) => x.unitName === unitName && x.role === role)!;
    const ctx = await http().post('/api/auth/context').set('authorization', `Bearer ${res.body.token}`).send({ unitId: a.unitId, role: a.role }).expect(200);
    return ctx.body.token as string;
  }

  beforeAll(async () => {
    const url = new URL(TEST_PG);
    Object.assign(process.env, {
      MASTER_DATABASE_URL: `postgresql://omni_app:omni_app@${url.hostname}:${url.port}/${MASTER}`,
      TENANT_DB_HOST: url.hostname,
      TENANT_DB_PORT: url.port,
      TENANT_DB_USER: 'omni_app',
      TENANT_DB_PASSWORD: 'omni_app',
      TENANT_ADMIN_USER: 'omni_admin',
      TENANT_ADMIN_PASSWORD: 'omni_admin',
      TENANT_BI_USER: 'omni_bi_reader',
      TENANT_BI_PASSWORD: 'omni_bi',
      JWT_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres!!',
      DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
      LOCAL_STORAGE_DIR: `/tmp/omni-test-storage-${process.pid}`,
    });
    const pg = new Client({ connectionString: TEST_PG });
    await pg.connect();
    for (const db of [MASTER, TENANT]) await pg.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await pg.query(`CREATE DATABASE ${MASTER} OWNER omni_app`);
    await pg.end();
    await applyMigrations(process.env.MASTER_DATABASE_URL!, 'master');
    const master = createMasterClient(process.env.MASTER_DATABASE_URL!);
    const seed = () => seedDemo({ master, credentials: envCredentials(), primaryHost: url.hostname, primaryPort: Number(url.port), slug: SLUG, territorioDemo: true, platformUser: false, now: AGORA });
    expect((await seed()).skipped).toBe(false);
    // Rodar de novo não duplica: o tenant já populado é pulado inteiro.
    expect((await seed()).skipped).toBe(true);
    await master.$disconnect();

    const { createApp } = await import('../src/main');
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    http = () => request(base);
    for (const s of [ContingenciaService, DiagramaService, NegativaService, SurtoService]) app.get(s).agora = () => AGORA;
    tk.vig = await login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    tk.nir = await login('nir', 'Policlínica Municipal', 'NIR');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    const pg = new Client({ connectionString: TEST_PG });
    await pg.connect();
    for (const db of [MASTER, TENANT]) await pg.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await pg.end();
  });

  it('contingência: plano modelo em vigor, normalidade desde o início do ano e sugestão de MOBILIZAÇÃO', async () => {
    const s = (await http().get('/api/vigilancia/contingencia').set(auth('vig')).expect(200)).body as SituacaoContingencia;
    expect(s.plano).toMatchObject({ status: 'VIGENTE', vigenteDesde: '2026-01-04' });
    expect(s.estagioAtual).toMatchObject({ chave: 'NORMALIDADE', desde: '2026-01-04' });
    expect(s.semanaReferencia).toBe('202642');
    expect(s.avaliacao!.sugerido).toBe('MOBILIZACAO');
    expect(s.avaliacao!.criterios.find((c) => c.id === 'mob-canal' && c.agravo === 'dengue')).toMatchObject({ atendido: true });
    expect(s.avaliacao!.criterios.filter((c) => c.estagio !== 'MOBILIZACAO' && c.atendido === true)).toEqual([]);
    expect(s.respostas.map((r) => r.criterio).sort()).toEqual(['mob-rtpcr', 'mob-sorotipo']);
    expect(s.checklist.length).toBeGreaterThan(10);
    expect(s.checklist.some((a) => a.status === 'FEITA')).toBe(true);
  });

  it('diagrama da dengue: receita do MS 2025 com a RIPSA, 2026 repetindo 2025 e as últimas semanas completas entre a mediana e o limite superior', async () => {
    const d = (await http().get('/api/vigilancia/diagrama').query({ grupo: 'dengue', nivel: 'MUNICIPIO', ano: 2026 }).set(auth('vig')).expect(200)).body as RespostaDiagrama;
    expect(d.configuracao).toMatchObject({ modelo: 'MS_2025', fontePopulacao: 'RIPSA', versaoPopulacao: '2000-2025', padrao: false });
    expect(d.canais[0]!.canal.anosReferencia).toEqual([2021, 2022, 2023, 2024, 2025]);
    expect(d.populacao.find((p) => p.ano === 2026)).toMatchObject({ populacao: 11_904_961, origem: 'REPETIDA' });
    const status = (se: number) => d.pontos.find((p) => p.ano === 2026 && p.semana === se)!.status;
    expect([39, 40, 41, 42].map(status)).toEqual(['ENTRE_CENTRO_E_LS', 'ENTRE_CENTRO_E_LS', 'ENTRE_CENTRO_E_LS', 'ENTRE_CENTRO_E_LS']);
    expect(d.semanasIncompletas).toEqual(['202643', '202644']);
    const epidemicos = (await http().get('/api/vigilancia/diagrama/anos-epidemicos').query({ grupo: 'dengue', ano: 2026 }).set(auth('vig')).expect(200)).body;
    expect(JSON.stringify(epidemicos)).toContain('2024');
  });

  it('negativa: a UBS Jardim das Flores fica silenciosa nas 3 últimas semanas fechadas; o CEO só manda negativas', async () => {
    const g = (await http().get('/api/vigilancia/negativas/grade').query({ semanas: 16 }).set(auth('vig')).expect(200)).body as RespostaGradeNegativa;
    const idDe = (key: string) => g.linhas.find((l) => l.unidade.cnes === unidade(key).cnes)!.unidade.id;
    expect(g.linhas).toHaveLength(6);
    expect(g.analise.silenciosas).toEqual([{ unitId: idDe('ubs2'), semanasSeguidas: 3 }]);
    expect(g.analise.soNegativas.map((x) => x.unitId)).toEqual([idDe('ceo')]);
    expect(g.analise.regularidadeMunicipal.irregular).toBe(false);
    const linha = (key: string) => g.linhas.find((l) => l.unidade.id === idDe(key))!.celulas.map((c) => c.situacao);
    expect(
      linha('upa')
        .slice(0, 15)
        .every((s) => s === 'POSITIVA'),
    ).toBe(true);
    expect(linha('hosp')).toContain('NEGATIVA_ATRASADA');
    expect(linha('poli').at(-2)).toBe('SEM_INFORMACAO');
    // Atestado e não digitado no Sinan (a última semana) e digitado no Sinan sem atesto (Policlínica).
    expect(g.atestadoSemSinan.length).toBeGreaterThan(0);
    expect(g.sinanSemAtesto.map((x) => x.unidade.cnes)).toEqual([unidade('poli').cnes]);
    // O responsável da Policlínica vê a semana que falta atestar.
    const minhas = (await http().get('/api/vigilancia/negativas/minhas').set(auth('nir')).expect(200)).body as RespostaMinhasNegativas;
    expect(minhas.unidades.map((u) => u.unidade.cnes)).toEqual([unidade('poli').cnes]);
    expect(JSON.stringify(minhas.unidades[0])).toContain('202643');
  });

  it('surtos: DTA aberto na escola e sugestão de surto pelas duas coqueluches do mesmo bairro', async () => {
    const abertos = (await http().get('/api/vigilancia/surtos').query({ status: 'ABERTO' }).set(auth('vig')).expect(200)).body as SurtoResumo[];
    expect(abertos).toHaveLength(1);
    expect(abertos[0]).toMatchObject({ categoria: 'DTA', casos: 14, casosNaPlanilha: 6, localInicial: '3' });
    const s = (await http().get('/api/vigilancia/surtos/sugestoes').set(auth('vig')).expect(200)).body as RespostaSugestoesSurto;
    const bairro = s.sugestoes.find((x) => x.regra === 'bairro-7d' && x.grupo === 'coqueluche');
    expect(bairro?.vinculoNome).toBe('Centro');
    expect(bairro?.casos).toHaveLength(2);
    // Coqueluche nunca vista no município: também evento inusitado.
    expect(s.sugestoes.some((x) => x.regra === 'inusitado' && x.grupo === 'coqueluche')).toBe(true);
  });

  it('conciliação: casadas pelo número, divergente, só no OmniSaúde, sugestão por nome e bairros sem correspondência', async () => {
    const resumo = (await http().get('/api/vigilancia/conciliacao/resumo').set(auth('vig')).expect(200)).body as ResumoConciliacao;
    expect(resumo.vinculados).toBe(2);
    expect(resumo.soOficial).toBeGreaterThan(5_000);
    const so = (await http().get('/api/vigilancia/conciliacao/so-omnisaude').set(auth('vig')).expect(200)).body as ListaSoOmnisaude;
    expect(so.itens.map((n) => n.paciente?.nome).sort()).toEqual(['Carlos Eduardo Martins', 'Juliana Rocha Mendes', 'Thiago Nascimento']);
    const div = (await http().get('/api/vigilancia/conciliacao/divergentes').set(auth('vig')).expect(200)).body as ListaDivergentes;
    expect(div.itens.map((p) => p.notificacao.paciente?.nome)).toEqual(['Maria Aparecida da Silva']);
    const sug = (await http().get('/api/vigilancia/conciliacao/sugestoes').set(auth('vig')).expect(200)).body as ListaSugestoesVinculo;
    expect(sug.itens.map((p) => [p.notificacao.paciente?.nome, p.degrau])).toEqual([['Thiago Nascimento', 3]]);
    const bairros = (await http().get('/api/vigilancia/conciliacao/bairros').set(auth('vig')).expect(200)).body as ListaBairrosSemCorrespondencia;
    expect(bairros.map((b) => b.nome)).toEqual(expect.arrayContaining(['JD DAS FLORES', 'VL NOVA']));
    expect(bairros.map((b) => b.nome)).not.toContain('VILA NOVA');
  });
});
