import { inflateSync } from 'node:zlib';
import { canonicalJson, demoFixtures, sha256, tenantSettings, type MasterClient } from '@omnisaude/database';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MASTER_DB, TenantsService } from '../src/core/database';
import { AdminService } from '../src/modules/admin/admin.service';
import { AiService } from '../src/modules/integrations/ai.service';
import { PlatformService } from '../src/modules/platform/platform.service';
import { NegativaService } from '../src/modules/vigilancia/negativa.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Semana 27, quarta rodada da notificação negativa, do cadastro e das configurações: a desativação que apaga o período
 * planejado da reabertura deixa a unidade reativada com aviso e "sem configuração" (sur-7, variante da reforma); a
 * parametrização da plataforma não desfaz o salvamento simultâneo da vigilância (N12); o atesto usa a configuração
 * gravada no mestre e grava o prazo, que o espelho imprime, e a tela de parâmetros lê o mestre (N13); a unidade inativa
 * não recebe fim de período depois de hoje, e a que tem esse fim (dado anterior) tem aviso e se corrige (N14); e a
 * abertura do período confere a unidade depois das travas, na transação (abrirPeriodo). Relógios fixos; dados sintéticos.
 */
const enabled = await pgAvailable();
const MOTIVO = 'Unidade desativada no cadastro';
const AVISO_REATIVADA = 'Unidade reativada: o período de notificante terminou na desativação. Abra um período novo se ela voltou a notificar.';
const at = (iso: string) => new Date(iso);
const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const hash = (payload: unknown) => sha256(canonicalJson(payload));
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

type Unidade = {
  unidade: { id: string; nome: string };
  ativa: boolean;
  periodoAtual: { desde: string; ate: string | null } | null;
  periodos: { desde: string; ate: string | null; motivoFim: string | null }[];
  semConfiguracao: boolean;
  avisos: string[];
};
type Grade = { linhas: { unidade: { id: string }; celulas: { semana: string; situacao: string }[] }[]; analise: { silenciosas: { unitId: string }[] }; avisos: string[] };

describe.runIf(enabled)('Notificação negativa, cadastro e configurações: quarta rodada da semana 27', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let admin: AdminService;
  let negativas: NegativaService;
  let master: MasterClient;
  let tenantId = '';
  const tk: Record<string, string> = {};
  const usuario: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const relogio = (d: Date) => {
    admin.agora = () => d;
    negativas.agora = () => d;
  };
  const trilha = (action: string, entityId: string) => db.auditEntry.findMany({ where: { action, entityId }, orderBy: { seq: 'asc' }, select: { userId: true, entityType: true, payloadHash: true } });
  const novaUnidade = async (name: string, cnes: string) =>
    (await t.http().post('/api/admin/units').set(auth('gestora')).send({ name, type: 'UBS', cnes, ibgeCode: '3550308' }).expect(201)).body as { id: string; cnes: string };
  const abrir = (unitId: string, desde: string) => t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId, desde }).expect(201);
  const pedirEncerramento = (unitId: string, ate: string, motivo: string) => t.http().post(`/api/vigilancia/unidades-notificantes/${unitId}/encerrar`).set(auth('vig')).send({ ate, motivo });
  const encerrar = (unitId: string, ate: string, motivo: string) => pedirEncerramento(unitId, ate, motivo).expect(200);
  const ativa = (unitId: string, active: boolean) => t.http().patch(`/api/admin/units/${unitId}`).set(auth('gestora')).send({ active }).expect(200);
  const daLista = async (id: string) => ((await t.http().get('/api/vigilancia/unidades-notificantes').set(auth('vig')).expect(200)).body as Unidade[]).find((u) => u.unidade.id === id)!;
  const grade = async (q: string) => (await t.http().get(`/api/vigilancia/negativas/grade?${q}`).set(auth('gestora')).expect(200)).body as Grade;
  const semPeriodo = (g: Grade) => Number(/^(\d+) unidade\(s\) ativa\(s\) sem período de unidade notificante/.exec(g.avisos.find((a) => a.includes('sem período de unidade notificante')) ?? '')?.[1] ?? 0);
  const patch = (corpo: Record<string, unknown>) => t.http().patch('/api/vigilancia/configuracoes').set(auth('vig')).send(corpo);
  /** O que está gravado no banco mestre (não o cache do catálogo). */
  const gravado = async () => tenantSettings((await master.tenant.findUniqueOrThrow({ where: { id: tenantId } })).settings);
  /** Outra conexão (superusuário) ao banco da instituição ou ao mestre, para segurar travas como uma transação concorrente. */
  const outraConexao = async (banco: 'tenant' | 'mestre') => {
    const url = new URL(TEST_PG);
    url.pathname = banco === 'tenant' ? `/tenant_db_${t.slug.replace(/-/g, '_')}` : new URL(process.env.MASTER_DATABASE_URL!).pathname;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };
  /** Espera (até 3 s) algum pedido da API ficar parado numa trava deste banco. */
  const esperarTrava = async (c: Client) => {
    for (let i = 0; i < 60; i++) {
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`);
      if (rows[0]!.n > 0) return;
      await esperar(50);
    }
    throw new Error('Nenhum pedido parou na trava');
  };

  beforeAll(async () => {
    t = await startTestApp('vignegr4');
    t.app.get(AiService).client = null;
    tk.gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    tenantId = (await tenants.resolve(t.slug)).id;
    db = await tenants.client(tenantId);
    master = t.app.get(MASTER_DB) as MasterClient;
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

  it('sur-7 (reforma): a desativação apaga o período planejado da reabertura; reativada, a unidade tem o aviso e conta em "sem configuração" até abrir período novo', async () => {
    // A vigilância encerra o período em 31/03 ("Reforma do prédio") e já abre o da reabertura planejada (01/07).
    relogio(at('2026-03-31T15:00:00Z'));
    const u = await novaUnidade('UBS R4 Reforma', '9004701');
    await abrir(u.id, '2026-01-01');
    await encerrar(u.id, '2026-03-31', 'Reforma do prédio');
    await abrir(u.id, '2026-07-01');
    const planejado = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: u.id, until: null } });
    // O gestor desativa a unidade em 17/06, durante a reforma: o planejado é apagado, com a trilha de sempre.
    const desativadaEm = at('2026-06-17T15:00:00Z');
    relogio(desativadaEm);
    await ativa(u.id, false);
    expect(await db.notifyingUnit.count({ where: { id: planejado.id } })).toBe(0);
    expect(await trilha('vigilancia.notificante_excluir', planejado.id)).toEqual([
      { userId: usuario.gestora, entityType: 'NotifyingUnit', payloadHash: hash({ unidade: u.cnes, desde: '2026-07-01', ate: null, motivoFim: null, motivo: MOTIVO }) },
    ]);
    // Inativa: nada a avisar.
    relogio(at('2026-06-24T15:00:00Z'));
    expect(await daLista(u.id)).toMatchObject({ ativa: false, semConfiguracao: false, avisos: [] });
    // Reativada na reabertura (01/07). Em 08/07: aviso e "sem configuração", na lista e na grade.
    relogio(at('2026-07-01T15:00:00Z'));
    await ativa(u.id, true);
    relogio(at('2026-07-08T15:00:00Z'));
    expect(await daLista(u.id)).toMatchObject({
      ativa: true,
      semConfiguracao: true,
      periodoAtual: null,
      periodos: [{ desde: '2026-01-01', ate: '2026-03-31', motivoFim: 'Reforma do prédio' }],
      avisos: [AVISO_REATIVADA],
    });
    const g = await grade('semanas=4');
    expect(g.avisos).toContain('Unidade reativada: o período de notificante de UBS R4 Reforma terminou na desativação. Abra um período novo se ela voltou a notificar.');
    // O período da reforma ficou como estava (o motivo é o dele), com a marca do planejado apagado na desativação.
    const reforma = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: u.id } });
    expect([dia(reforma.since), dia(reforma.until), reforma.endReason, reforma.nextRemovedAt?.toISOString()]).toEqual(['2026-01-01', '2026-03-31', 'Reforma do prédio', desativadaEm.toISOString()]);
    // A vigilância abre o período novo: a unidade sai do aviso e da contagem, e não volta quando ele for encerrado.
    await abrir(u.id, '2026-07-09');
    expect(await daLista(u.id)).toMatchObject({ semConfiguracao: false, avisos: [], periodoAtual: { desde: '2026-07-09', ate: null } });
    const depois = await grade('semanas=4');
    expect(depois.avisos.some((a) => a.includes('UBS R4 Reforma'))).toBe(false);
    expect(semPeriodo(depois)).toBe(semPeriodo(g) - 1);
    relogio(at('2026-07-15T15:00:00Z'));
    await encerrar(u.id, '2026-07-14', 'Fim do atendimento temporário');
    expect(await daLista(u.id)).toMatchObject({ semConfiguracao: false, avisos: [] });
  });

  it('N12: a plataforma lê as configurações e segura a linha; o salvamento da vigilância ao mesmo tempo espera e não se perde', async () => {
    await patch({ negativa: { prazoHora: '14:00' } }).expect(200);
    const plataforma = t.app.get(PlatformService) as unknown as { master: MasterClient; update: PlatformService['update'] };
    const original = plataforma.master;
    let leu: () => void = () => {};
    const lido = new Promise<void>((r) => (leu = r));
    let soltar: () => void = () => {};
    const segurar = new Promise<void>((r) => (soltar = r));
    // Segura a plataforma logo depois de ler as configurações: a leitura com trava, na transação, ou a sem trava.
    const depoisDeLer = async <T>(p: PromiseLike<T>): Promise<T> => {
      const r = await p;
      leu();
      await segurar;
      return r;
    };
    const comLeituraSegura = <T extends object>(alvo: T, metodo: string): T =>
      new Proxy(alvo, {
        get(a, p) {
          const v = Reflect.get(a, p) as unknown;
          if (p !== metodo || typeof v !== 'function') return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(a) : v;
          return (...args: unknown[]) => depoisDeLer((v as (...x: unknown[]) => PromiseLike<unknown>).apply(a, args));
        },
      });
    plataforma.master = new Proxy(original, {
      get(a, p) {
        if (p === '$transaction')
          return (fn: (tx: object) => Promise<unknown>, ...resto: unknown[]) =>
            (original.$transaction as (f: (tx: object) => Promise<unknown>, ...r: unknown[]) => Promise<unknown>)((tx) => fn(comLeituraSegura(tx, '$queryRaw')), ...resto);
        if (p === 'tenant') return comLeituraSegura(original.tenant, 'findUnique');
        const v = Reflect.get(a, p) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(a) : v;
      },
    });
    try {
      const plat = plataforma.update(usuario.vigilancia!, tenantId, { settings: { whatsappEnabled: true } });
      await lido;
      // A vigilância salva o prazo enquanto a plataforma está entre a leitura e a gravação.
      const vig = patch({ negativa: { prazoHora: '17:45' } }).then((x) => x);
      const terminou = await Promise.race([vig.then(() => true), esperar(1_500).then(() => false)]);
      // Com a linha travada pela plataforma, o salvamento da vigilância espera (antes, terminava e era desfeito).
      expect(terminou).toBe(false);
      soltar();
      const [rp, rv] = await Promise.all([plat, vig]);
      expect(rp.settings.whatsappEnabled).toBe(true);
      expect([rv.status, rv.body.negativa?.prazoHora, rv.body.whatsappEnabled]).toEqual([200, '17:45', true]);
    } finally {
      soltar();
      plataforma.master = original;
    }
    const s = await gravado();
    expect([s.vigilancia.negativa.prazoHora, s.whatsappEnabled]).toEqual(['17:45', true]);
  });

  it('N12 (variante do revisor): a vigilância na fila antes da plataforma; as duas mudanças ficam gravadas', async () => {
    await patch({ negativa: { prazoHora: '14:00' } }).expect(200);
    await t.app.get(PlatformService).update(usuario.vigilancia!, tenantId, { settings: { whatsappEnabled: false } });
    const outra = await outraConexao('mestre');
    try {
      await outra.query('BEGIN');
      await outra.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
      const vig = patch({ negativa: { prazoHora: '17:45' } }).then((x) => x);
      await esperarTrava(outra);
      const plat = t.app.get(PlatformService).update(usuario.vigilancia!, tenantId, { settings: { whatsappEnabled: true } });
      await esperar(300);
      await outra.query('COMMIT');
      const [rv] = await Promise.all([vig, plat]);
      expect([rv.status, rv.body.negativa?.prazoHora]).toEqual([200, '17:45']);
    } finally {
      await outra.query('ROLLBACK').catch(() => {});
      await outra.end();
    }
    const s = await gravado();
    expect([s.vigilancia.negativa.prazoHora, s.whatsappEnabled]).toEqual(['17:45', true]);
  });

  it('N13 (cenário do revisor): a leitura do catálogo que atravessa o salvamento não deixa a configuração velha em uso; o atesto das 14h30 com o prazo das 18h fica no prazo', async () => {
    // Base: prazo segunda 14h. Segunda 22/06 às 14h30 (Brasília) a vigilância estende para 18h e a unidade atesta a SE 24.
    await patch({ negativa: { prazoDiaSemana: 1, prazoHora: '14:00' } }).expect(200);
    relogio(at('2026-06-17T15:00:00Z'));
    const u = await novaUnidade('UBS R4 Cache Revisor', '9004751');
    await abrir(u.id, '2026-01-01');
    const conexoes = t.app.get(TenantsService).connections as unknown as { master: MasterClient; invalidate: (s?: string) => void };
    const original = conexoes.master;
    let soltar: () => void = () => {};
    let armado = false;
    conexoes.master = new Proxy(original, {
      get(alvo, prop, rec) {
        if (prop !== 'tenant') return Reflect.get(alvo, prop, rec);
        const tenant = Reflect.get(alvo, prop, rec) as MasterClient['tenant'];
        return new Proxy(tenant, {
          get(t2, p2, r2) {
            if (p2 !== 'findUnique') return Reflect.get(t2, p2, r2);
            return async (args: Parameters<MasterClient['tenant']['findUnique']>[0]) => {
              const r = await t2.findUnique(args);
              if (armado) {
                armado = false;
                await new Promise<void>((s) => (soltar = s));
              }
              return r;
            };
          },
        });
      },
    });
    try {
      relogio(at('2026-06-22T17:30:00Z'));
      armado = true;
      conexoes.invalidate();
      // Um pedido qualquer da instituição resolve o catálogo (lê o prazo 14h) e fica para trás.
      const lento = t
        .http()
        .get('/api/vigilancia/configuracoes')
        .set(auth('vig'))
        .then((x) => x);
      await esperar(200);
      const salvo = await patch({ negativa: { prazoHora: '18:00' } });
      expect([salvo.status, salvo.body.negativa?.prazoHora]).toEqual([200, '18:00']);
      soltar();
      expect((await lento).status).toBe(200);
      // O cache não ficou com a configuração velha: a leitura seguinte e o atesto usam o prazo das 18h.
      expect((await t.app.get(TenantsService).resolve(t.slug)).settings.vigilancia.negativa.prazoHora).toBe('18:00');
      expect((await t.http().get('/api/vigilancia/configuracoes').set(auth('vig')).expect(200)).body.negativa.prazoHora).toBe('18:00');
      const a = await t
        .http()
        .post('/api/vigilancia/negativas')
        .set(auth('vig'))
        .send({ unitId: u.id, semana: '202624', emNome: { motivo: 'Teste do prazo estendido pela vigilância' } });
      expect([a.status, a.body.atrasado]).toEqual([201, false]);
    } finally {
      soltar();
      conexoes.master = original;
      conexoes.invalidate();
    }
  });

  it('N13 (outra instância): com o cache desta instância velho, o atesto calcula o prazo com o mestre, grava o prazo usado, e a tela de parâmetros lê o mestre', async () => {
    await patch({ negativa: { prazoDiaSemana: 1, prazoHora: '14:00' } }).expect(200);
    relogio(at('2026-06-17T15:00:00Z'));
    const u = await novaUnidade('UBS R4 Outra Instancia', '9004752');
    await abrir(u.id, '2026-01-01');
    const tenants = t.app.get(TenantsService);
    try {
      // O cache desta instância fica com o prazo das 14h; outra instância (réplica da API) salva 18h no mestre.
      expect((await tenants.resolve(t.slug)).settings.vigilancia.negativa.prazoHora).toBe('14:00');
      await master.$executeRaw`UPDATE tenants SET settings = jsonb_set(settings, '{vigilancia,negativa,prazoHora}', '"18:00"'::jsonb) WHERE id = ${tenantId}::uuid`;
      expect((await tenants.resolve(t.slug)).settings.vigilancia.negativa.prazoHora).toBe('14:00');
      // A tela de parâmetros mostra o gravado (N13 d).
      expect((await t.http().get('/api/vigilancia/configuracoes').set(auth('vig')).expect(200)).body.negativa.prazoHora).toBe('18:00');
      // Segunda 22/06, 14h30: o atesto da SE 24 fica no prazo (N13 b), com o prazo usado gravado (N13 c).
      relogio(at('2026-06-22T17:30:00Z'));
      const a = await t
        .http()
        .post('/api/vigilancia/negativas')
        .set(auth('vig'))
        .send({ unitId: u.id, semana: '202624', emNome: { motivo: 'Teste do prazo salvo por outra instância' } });
      expect([a.status, a.body.atrasado]).toEqual([201, false]);
      expect((await db.negativeReport.findUniqueOrThrow({ where: { id: a.body.id } })).deadlineAt?.toISOString()).toBe('2026-06-22T21:00:00.000Z');
      // Às 18h30, o da SE 23 (prazo 15/06 às 18h) fica atrasado, também com o prazo gravado.
      relogio(at('2026-06-22T21:30:00Z'));
      const b = await t
        .http()
        .post('/api/vigilancia/negativas')
        .set(auth('vig'))
        .send({ unitId: u.id, semana: '202623', emNome: { motivo: 'Teste do atesto atrasado com o prazo gravado' } });
      expect([b.status, b.body.atrasado]).toEqual([201, true]);
      expect((await db.negativeReport.findUniqueOrThrow({ where: { id: b.body.id } })).deadlineAt?.toISOString()).toBe('2026-06-15T21:00:00.000Z');
    } finally {
      tenants.connections.invalidate();
    }
  });

  it('N13 (espelho): depois de mudar o prazo, o espelho imprime o prazo gravado com o atesto, não o recalculado', async () => {
    await patch({ negativa: { prazoDiaSemana: 1, prazoHora: '18:00' } }).expect(200);
    relogio(at('2026-06-17T15:00:00Z'));
    const u = await novaUnidade('UBS R4 Espelho', '9004753');
    await abrir(u.id, '2026-01-01');
    relogio(at('2026-06-22T17:30:00Z'));
    const noPrazo = (
      await t
        .http()
        .post('/api/vigilancia/negativas')
        .set(auth('vig'))
        .send({ unitId: u.id, semana: '202624', emNome: { motivo: 'Atesto no prazo para o espelho' } })
        .expect(201)
    ).body as {
      id: string;
      atrasado: boolean;
    };
    const atrasado = (
      await t
        .http()
        .post('/api/vigilancia/negativas')
        .set(auth('vig'))
        .send({ unitId: u.id, semana: '202623', emNome: { motivo: 'Atesto atrasado para o espelho' } })
        .expect(201)
    ).body as {
      id: string;
      atrasado: boolean;
    };
    expect([noPrazo.atrasado, atrasado.atrasado]).toEqual([false, true]);
    // A vigilância volta o prazo para as 13h.
    await patch({ negativa: { prazoHora: '13:00' } }).expect(200);
    const espelho = async (id: string) =>
      textoDoPdf(
        (
          await t
            .http()
            .get(`/api/vigilancia/negativas/${id}/espelho.pdf`)
            .set(auth('vig'))
            .buffer(true)
            .parse((res, cb) => {
              const partes: Buffer[] = [];
              res.on('data', (c: Buffer) => partes.push(c));
              res.on('end', () => cb(null, Buffer.concat(partes)));
            })
            .expect(200)
        ).body as Buffer,
      );
    const textoNoPrazo = espelho(noPrazo.id);
    expect(await textoNoPrazo).toMatch(/No prazo \(até 22\/06\/2026,? 18:00\)/);
    expect(await textoNoPrazo).not.toContain('13:00');
    const textoAtrasado = await espelho(atrasado.id);
    expect(textoAtrasado).toMatch(/FORA DO PRAZO: o prazo era 15\/06\/2026,? 18:00/);
    await patch({ negativa: { prazoHora: '14:00' } }).expect(200);
  });

  it('N14: a unidade inativa não recebe fim de período depois de hoje; a que já tem esse fim (dado anterior) tem aviso e se encerra até hoje', async () => {
    relogio(at('2026-06-17T15:00:00Z'));
    const u = await novaUnidade('UBS R4 Inativa Aberta', '9004711');
    await abrir(u.id, '2026-01-01');
    // Estado anterior a esta versão (ou de outro caminho): inativa com período aberto.
    await db.unit.update({ where: { id: u.id }, data: { active: false } });
    expect((await daLista(u.id)).avisos).toEqual(['Unidade inativa com período de notificante aberto. Encerre o período na data da desativação.']);
    // A vigilância segue o aviso, mas digita uma data futura: 422, e nada muda.
    const futuro = await pedirEncerramento(u.id, '2026-12-31', 'Unidade desativada');
    expect([futuro.status, futuro.body.code, futuro.body.message]).toEqual([422, 'FIM_DEPOIS_DE_HOJE', 'A unidade está inativa: o fim do período não pode passar de hoje (17/06/2026). Use a data da desativação.']);
    expect((await db.notifyingUnit.findFirstOrThrow({ where: { unitId: u.id } })).until).toBeNull();
    // Até hoje vale.
    await encerrar(u.id, '2026-06-10', 'Unidade desativada no CNES');
    expect(await daLista(u.id)).toMatchObject({ periodos: [{ desde: '2026-01-01', ate: '2026-06-10' }], avisos: [] });

    // Dado anterior: o período foi encerrado com data futura com a unidade ativa (vale), e a unidade ficou inativa por
    // outro caminho, sem o encurtamento da desativação no cadastro.
    const v = await novaUnidade('UBS R4 Inativa Fim Futuro', '9004712');
    await abrir(v.id, '2026-01-01');
    await encerrar(v.id, '2026-12-31', 'Transferência planejada');
    await db.unit.update({ where: { id: v.id }, data: { active: false } });
    const p = await db.notifyingUnit.findFirstOrThrow({ where: { unitId: v.id } });
    expect((await daLista(v.id)).avisos).toEqual(['Unidade inativa com período de notificante até 31/12/2026, depois de hoje. Encerre o período na data da desativação.']);
    relogio(at('2026-07-15T15:00:00Z'));
    const g = await grade('semanas=6&ate=202628');
    expect(g.avisos).toContain('UBS R4 Inativa Fim Futuro está inativa e com período de notificante até 31/12/2026: entra como silenciosa e no percentual até lá. Encerre o período na data da desativação.');
    expect(g.analise.silenciosas.map((s) => s.unitId)).toContain(v.id);
    // O encerramento alcança esse período: depois de hoje, 422; na data da desativação, encurta o fim.
    expect((await pedirEncerramento(v.id, '2026-07-16', 'Unidade desativada no cadastro')).status).toBe(422);
    await encerrar(v.id, '2026-06-17', 'Unidade desativada em 17/06');
    const depois = await db.notifyingUnit.findUniqueOrThrow({ where: { id: p.id } });
    expect([dia(depois.until), depois.endReason, depois.endedBy]).toEqual(['2026-06-17', 'Unidade desativada em 17/06', usuario.vigilancia]);
    expect((await trilha('vigilancia.notificante_encerrar', p.id)).map((e) => e.payloadHash)).toEqual([
      hash({ unidade: v.cnes, ate: '2026-12-31', motivo: 'Transferência planejada' }),
      hash({ unidade: v.cnes, ate: '2026-06-17', motivo: 'Unidade desativada em 17/06', fimAnterior: '2026-12-31', motivoAnterior: 'Transferência planejada' }),
    ]);
    expect((await daLista(v.id)).avisos).toEqual([]);
    const g2 = await grade('semanas=6&ate=202628');
    expect(g2.avisos.filter((a) => a.includes('UBS R4 Inativa Fim Futuro'))).toEqual([]);
    expect(g2.linhas.find((l) => l.unidade.id === v.id)!.celulas.map((c) => [c.semana, c.situacao])).toEqual([
      ['202623', 'SEM_INFORMACAO'],
      ['202624', 'SEM_INFORMACAO'],
      ['202625', 'NAO_NOTIFICANTE'],
      ['202626', 'NAO_NOTIFICANTE'],
      ['202627', 'NAO_NOTIFICANTE'],
      ['202628', 'NAO_NOTIFICANTE'],
    ]);
    expect(g2.analise.silenciosas.map((s) => s.unitId)).not.toContain(v.id);
    // Sem período aberto nem com fim futuro, não há o que encerrar; na unidade ativa, só o aberto se encerra.
    expect((await pedirEncerramento(v.id, '2026-06-10', 'Corrigir de novo')).body.code).toBe('SEM_PERIODO_ABERTO');
    const w = await novaUnidade('UBS R4 Ativa Fim Futuro', '9004713');
    await abrir(w.id, '2026-01-01');
    await encerrar(w.id, '2026-12-31', 'Transferência planejada');
    expect((await pedirEncerramento(w.id, '2026-08-31', 'Transferência antecipada')).body.code).toBe('SEM_PERIODO_ABERTO');
  });

  it('abrirPeriodo: a abertura e a desativação ao mesmo tempo não deixam a unidade inativa com período aberto', async () => {
    relogio(at('2026-06-17T15:00:00Z'));
    const u = await novaUnidade('UBS R4 Abre e Desativa', '9004761');
    const outra = await outraConexao('tenant');
    let abertura: Promise<{ status: number }> | null = null;
    let desativacao: Promise<{ status: number }> | null = null;
    try {
      await outra.query('BEGIN');
      // Segura a gravação de períodos (a leitura com FOR UPDATE passa): a abertura para na hora de gravar, depois de
      // conferir a unidade.
      await outra.query('LOCK TABLE notifying_units IN SHARE MODE');
      abertura = t
        .http()
        .post('/api/vigilancia/unidades-notificantes')
        .set(auth('vig'))
        .send({ unitId: u.id, desde: '2026-06-17' })
        .then((x) => x);
      await esperarTrava(outra);
      // A desativação chega com a abertura parada: antes, conferia nada aberto e terminava; agora espera a abertura.
      desativacao = t
        .http()
        .patch(`/api/admin/units/${u.id}`)
        .set(auth('gestora'))
        .send({ active: false })
        .then((x) => x);
      await Promise.race([desativacao, esperar(1_500)]);
      await outra.query('COMMIT');
      const [ra, rd] = await Promise.all([abertura, desativacao]);
      expect([ra.status, rd.status]).toEqual([201, 200]);
    } finally {
      await outra.query('ROLLBACK').catch(() => {});
      await outra.end();
      await Promise.allSettled([abertura, desativacao]);
    }
    // A desativação esperou a abertura e encerrou o período novo no dia.
    expect((await db.unit.findUniqueOrThrow({ where: { id: u.id } })).active).toBe(false);
    const periodos = await db.notifyingUnit.findMany({ where: { unitId: u.id } });
    expect(periodos.map((p) => [dia(p.since), dia(p.until), p.endReason])).toEqual([['2026-06-17', '2026-06-17', MOTIVO]]);
    // A ordem inversa: com a desativação primeiro, a abertura encontra a unidade inativa.
    const r = await t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: u.id, desde: '2026-06-18' });
    expect([r.status, r.body.code]).toEqual([422, 'UNIDADE_INATIVA']);

    // A desativação que também troca o CNES prende a linha da unidade para as chaves (a gravação do período a lê): a
    // trava da unidade notificante vem antes, e as duas terminam sem impasse.
    const c = await novaUnidade('UBS R4 Abre e Troca CNES', '9004762');
    const outra2 = await outraConexao('tenant');
    let abertura2: Promise<{ status: number }> | null = null;
    let desativacao2: Promise<{ status: number }> | null = null;
    try {
      await outra2.query('BEGIN');
      await outra2.query('LOCK TABLE notifying_units IN SHARE MODE');
      abertura2 = t
        .http()
        .post('/api/vigilancia/unidades-notificantes')
        .set(auth('vig'))
        .send({ unitId: c.id, desde: '2026-06-17' })
        .then((x) => x);
      await esperarTrava(outra2);
      desativacao2 = t
        .http()
        .patch(`/api/admin/units/${c.id}`)
        .set(auth('gestora'))
        .send({ active: false, cnes: '9004763' })
        .then((x) => x);
      await Promise.race([desativacao2, esperar(1_500)]);
      await outra2.query('COMMIT');
      const [ra, rd] = await Promise.all([abertura2, desativacao2]);
      expect([ra.status, rd.status]).toEqual([201, 200]);
    } finally {
      await outra2.query('ROLLBACK').catch(() => {});
      await outra2.end();
      await Promise.allSettled([abertura2, desativacao2]);
    }
    expect(await db.unit.findUniqueOrThrow({ where: { id: c.id }, select: { active: true, cnes: true } })).toEqual({ active: false, cnes: '9004763' });
    expect((await db.notifyingUnit.findMany({ where: { unitId: c.id } })).map((p) => [dia(p.since), dia(p.until), p.endReason])).toEqual([['2026-06-17', '2026-06-17', MOTIVO]]);
    // Várias rodadas sem intercalação forçada: nunca sobra unidade inativa com período aberto.
    for (let i = 0; i < 6; i++) {
      const x = await novaUnidade(`UBS R4 Corrida ${i}`, `900477${i}`);
      await Promise.all([
        t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId: x.id, desde: '2026-06-17' }),
        t.http().patch(`/api/admin/units/${x.id}`).set(auth('gestora')).send({ active: false }),
      ]);
      expect(await db.notifyingUnit.count({ where: { unitId: x.id, until: null } })).toBe(0);
    }
  });
});
