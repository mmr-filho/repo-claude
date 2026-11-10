import { createHash } from 'node:crypto';
import {
  areaM2,
  caixaDe,
  calcularPrazo,
  centroDe,
  chaveNatural,
  cnsFromBase,
  competencia,
  completeCpf,
  deslocarSemana,
  distanciaAteArea,
  fromZonedParts,
  gravidadeOficial,
  gs1HumanReadable,
  idadeSinan,
  inicioAnoEpidemiologico,
  intervaloDaSemana,
  LNNC_NACIONAL,
  localDateString,
  metrosPorGrau,
  normalizarArea,
  normalizarNomePessoa,
  personNameKey,
  PLANO_MODELO_MS_2025,
  prazoDaNegativa,
  RECEITAS_MODELO,
  ROLE_LABELS,
  semanaDaData,
  situacaoOficial,
  textoDoAtesto,
  versaoNaData,
  type Area,
  type Role,
} from '@omnisaude/shared';
import type { PrismaClient as MasterClient } from '../generated/master/client';
import type { Prisma, PrismaClient as TenantClient } from '../generated/tenant/client';
import { appendAudit } from '../audit';
import { hashPassword } from '../passwords';
import { provisionTenant } from '../provision';
import { DEFAULT_TENANT_SETTINGS } from '../settings';
import { connectionUrl, type CredentialsResolver } from '../tenancy';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/tenant/client';
import {
  ANOS_HISTORICO_DEMO,
  CENSO_2022_DEMO,
  DEMO_PASSWORD,
  DEMO_PROPERTIES,
  DEMO_TENANT,
  gravesDemo,
  IMPORTACAO_DEMO,
  LARVICIDES,
  NEGATIVA_DEMO,
  NOMES_SINTETICOS,
  NOTIFICACOES_DEMO,
  PATIENTS,
  POPS,
  POPULACAO_RIPSA_DEMO,
  PRODUCTS,
  RESPONSAVEIS_NEGATIVA_DEMO,
  semanasDemo,
  seriesDemo,
  SIGTAP_SAMPLE,
  STAFF,
  SURTO_DEMO,
  UNITS,
  VACCINES,
  type GrupoDemo,
  type UnitKey,
} from './fixtures';

export interface SeedOptions {
  master: MasterClient;
  credentials: CredentialsResolver;
  primaryHost: string;
  primaryPort: number;
  replicaHost?: string;
  replicaPort?: number;
  /** Habilita as integrações de demonstração (apontando para os mocks). */
  settings?: Record<string, unknown>;
  now?: Date;
  /** Slug do tenant (padrão "demo"); os testes usam outro para não tocar no banco de desenvolvimento. */
  slug?: string;
  /** false quando a conta da plataforma tem senha própria (PLATFORM_ADMIN_PASSWORD) em vez da senha pública. */
  platformUser?: boolean;
  /**
   * Malha de quarteirões de demonstração sobre os domicílios de exemplo, com os imóveis ligados e a zona do ACE (VIG-3a).
   * Ligada pela linha de comando; os testes da API constroem a própria malha.
   */
  territorioDemo?: boolean;
  /**
   * Consolidação e detecção de surto (VIG-1c, semana 27): população, importação sintética do Sinan, diagrama, plano de
   * contingência, surto, notificação negativa e unidade silenciosa. Padrão: junto com a malha (a linha de comando); os
   * testes da API não a carregam.
   */
  consolidacaoDemo?: boolean;
}

const DAY = 86_400_000;
export const DEMO_PLATFORM_EMAIL = 'plataforma@omnisaude.dev';

/**
 * Popula o master com um operador da plataforma e cria o tenant "demo" com uma rede completa:
 * unidades, equipe por papel, pacientes crônicos, agenda, estoque, leitos, SIGTAP, POPs e histórico.
 * Só roda em banco de tenant vazio.
 */
/**
 * Malha de demonstração: localidade 1 (sede), bairro Centro e 36 quarteirões de 80 m (ruas de 20 m) numerados a partir
 * do sudoeste, cobrindo os domicílios de exemplo; imóveis sem família (comércio, terreno baldio, ponto estratégico,
 * escola) e a zona 01 com o ACE titular. Os imóveis são ligados ao quarteirão como faria o localizador (até 15 m da borda).
 */
async function territorioDemo(db: TenantClient, p: { households: string[]; unitVig: string; ace: string; coordenador: string }) {
  const locality = await db.locality.create({ data: { code: '1', name: 'Sede (demonstração)', category: 'CIDADE', zone: 'URBANA', source: 'MANUAL', createdBy: p.coordenador } });
  const bairro = await db.neighborhood.create({ data: { localityId: locality.id, name: 'Centro', official: true, aliases: ['Vila Nova', 'Jardim das Flores'] } });
  const origem = { lat: -11.732, lng: -49.0715 };
  const m = metrosPorGrau(origem.lat);
  const ponto = (lesteM: number, norteM: number): [number, number] => [Number((origem.lng + lesteM / m.lng).toFixed(6)), Number((origem.lat + norteM / m.lat).toFixed(6))];
  const blocos: { id: string; area: Area }[] = [];
  for (let linha = 0; linha < 6; linha++)
    for (let coluna = 0; coluna < 6; coluna++) {
      const x = coluna * 100 + 10;
      const y = linha * 100 + 10;
      const area = normalizarArea({ type: 'Polygon', coordinates: [[ponto(x, y), ponto(x + 80, y), ponto(x + 80, y + 80), ponto(x, y + 80), ponto(x, y)]] });
      const [minLng, minLat, maxLng, maxLat] = caixaDe(area);
      const [centerLng, centerLat] = centroDe(area);
      const b = await db.block.create({
        data: {
          localityId: locality.id,
          neighborhoodId: bairro.id,
          number: String(linha * 6 + coluna + 1),
          geometry: area as object,
          minLng,
          minLat,
          maxLng,
          maxLat,
          centerLat,
          centerLng,
          areaM2: areaM2(area),
          source: 'EDITOR',
          createdBy: p.coordenador,
          updatedBy: p.coordenador,
        },
      });
      blocos.push({ id: b.id, area });
    }
  const extras: string[] = [];
  for (const prop of DEMO_PROPERTIES) {
    const h = await db.household.create({
      data: {
        street: prop.street,
        number: prop.number,
        district: 'Centro',
        ibgeCode: DEMO_TENANT.ibgeCode,
        city: 'Gurupi',
        uf: 'TO',
        propertyType: prop.propertyType,
        latitude: prop.lat,
        longitude: prop.lng,
        geoPrecision: 'GPS_CAMPO',
        geoSource: 'seed',
        geoAt: new Date(),
        notes: prop.notes,
      },
    });
    extras.push(h.id);
  }
  const imoveis = await db.household.findMany({ where: { id: { in: [...p.households, ...extras] } }, select: { id: true, latitude: true, longitude: true } });
  const porBloco = new Map<string, { id: string; lng: number }[]>();
  for (const h of imoveis) {
    if (h.latitude == null || h.longitude == null) continue;
    let melhor: { id: string; d: number } | null = null;
    for (const b of blocos) {
      const d = distanciaAteArea([h.longitude, h.latitude], b.area);
      if (d <= 15 && (!melhor || d < melhor.d)) melhor = { id: b.id, d };
    }
    if (melhor) porBloco.set(melhor.id, [...(porBloco.get(melhor.id) ?? []), { id: h.id, lng: h.longitude }]);
  }
  for (const [blockId, lista] of porBloco)
    for (const [i, h] of lista.sort((a, b) => a.lng - b.lng).entries())
      // SQL direto, como o localizador: não muda o updated_at (que regeraria a ficha de cadastro domiciliar do e-SUS).
      await db.$executeRaw`UPDATE households SET block_id = ${blockId}::uuid, rg_sequence = ${String(i + 1)} WHERE id = ${h.id}::uuid`;
  await db.vectorZone.create({ data: { unitId: p.unitVig, name: 'Zona 01', aceId: p.ace, createdBy: p.coordenador, blocks: { create: blocos.map((b) => ({ blockId: b.id })) } } });
}

// ───────────────────────── Semana 27 (VIG-1c): consolidação, diagrama, contingência, surto e negativa ─────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Coluna date a partir de AAAA-MM-DD. */
const dataCivil = (iso: string) => new Date(`${iso}T00:00:00Z`);
const somarDias = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const doisDigitos = (n: number) => String(n).padStart(2, '0');
/** Raça/cor do cadastro (e-SUS) → Sinan, como na ficha da API. */
const RACA_SINAN: Record<string, string> = { '01': '1', '02': '2', '03': '4', '04': '3', '05': '5', '99': '9' };
/** Unidades que não entram na notificação negativa (como na semeadura da migração 0030). */
const FORA_DA_NEGATIVA = ['FARMACIA_CENTRAL', 'ALMOXARIFADO', 'VIGILANCIA_SAUDE'];

interface ContextoConsolidacao {
  now: Date;
  timeZone: string;
  ibgeCode: string;
  uf: string;
  unit: Record<UnitKey, string>;
  staff: Record<string, string>;
  patient: Record<string, string>;
}

/** Registro oficial sintético, montado em memória antes de gravar. */
interface RegistroDemo {
  grupo: GrupoDemo;
  inicio: string;
  notificadoEm: string;
  semanaNot: string;
  classificacao: string | null;
  criterio: string | null;
  evolucao: string | null;
  encerradoEm: string | null;
  obitoEm: string | null;
  unidade: UnitKey | null;
  bairro: string;
  nome: string;
  nascimento: string;
  sexo: 'M' | 'F';
  mae: string;
  cns: string | null;
  /** Notificação da demonstração que corresponde ao registro (casada ou sugerida). */
  notificacao?: string;
  numero?: string;
}

/**
 * Demonstração da semana 27 (VIG-1c), relativa ao dia em que a carga roda: catálogo nacional da lista (as notificações
 * apontam para ele), população (RIPSA e Censo 2022), importação sintética APLICADA do Sinan Online (dengue de 7 anos,
 * com o penúltimo epidêmico, e chikungunya menor) e do Sinan Net (negativas digitadas), notificações casadas e não
 * casadas, receita do diagrama, plano modelo do MS em vigor com acionamento NORMALIDADE, surto de DTA aberto, par de
 * coqueluche que gera sugestão de surto, unidades notificantes, responsáveis, atestos e a UBS Jardim das Flores
 * silenciosa nas 3 últimas semanas fechadas. A sugestão do plano no dia da carga é MOBILIZAÇÃO.
 */
async function consolidacaoDemo(db: TenantClient, c: ContextoConsolidacao) {
  const tz = c.timeZone;
  const vera = c.staff.vigilancia!;
  const cfg = DEFAULT_TENANT_SETTINGS.vigilancia;
  const sem = semanasDemo(c.now, tz, cfg.consolidacao.semanasIncompletas);
  const hoje = localDateString(c.now, tz);
  const domingoDeHoje = new Date(`${hoje}T12:00:00Z`).getUTCDay();
  const limite = new Date(c.now.getTime() - 5 * 60_000);
  /** Nada da demonstração fica depois de agora. */
  const noPassado = (d: Date) => (d.getTime() > limite.getTime() ? limite : d);
  const ate = (iso: string) => (iso > hoje ? hoje : iso);
  /** Dia da semana AAAASS (0 = domingo). */
  const diaDa = (semana: string, dow: number) => somarDias(intervaloDaSemana(Number(semana.slice(0, 4)), Number(semana.slice(4))).inicio, dow);
  const as = (iso: string, hora: number, minuto = 0) => fromZonedParts({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)), hour: hora, minute: minuto, second: 0 }, tz);
  const semanaK = (k: number) => deslocarSemana(sem.atual, -k);
  /** Semana AAAASS → k (0 = a em curso, 1 = a anterior...), nas semanas da grade da negativa; fora dela, −1. */
  const kPorSemana = new Map(Array.from({ length: NEGATIVA_DEMO.semanas + 1 }, (_, k) => [semanaK(k), k] as const));
  const kDa = (semana: string) => kPorSemana.get(semana) ?? -1;
  const municipio6 = c.ibgeCode.slice(0, 6);
  const unidade = (k: UnitKey) => UNITS.find((u) => u.key === k)!;
  const porCnes = new Map<string, UnitKey>(UNITS.map((u) => [u.cnes, u.key]));
  const [sede, centro] = await Promise.all([db.locality.findFirst({ where: { name: 'Sede (demonstração)' } }), db.neighborhood.findFirst({ where: { name: 'Centro' } })]);
  /** Início dos períodos de notificante e das designações: 1º de janeiro, ou antes se a grade de 16 semanas pedir. */
  const inicioDemo = [`${sem.atual.slice(0, 4)}-01-01`, diaDa(semanaK(NEGATIVA_DEMO.semanas + 4), 0)].sort()[0]!;
  const inicioAno = new Date(inicioAnoEpidemiologico(sem.anoAnalise)).toISOString().slice(0, 10);

  // ── Catálogo nacional da lista: a API completa e atualiza na primeira leitura (hash nulo), mantendo os ids ──
  for (const v of LNNC_NACIONAL) {
    const versao =
      (await db.notifiableListVersion.findUnique({ where: { nationalId: v.id } })) ??
      (await db.notifiableListVersion.create({
        data: {
          scope: 'NACIONAL',
          scopeKey: 'NACIONAL',
          nationalId: v.id,
          act: v.act,
          publishedIn: v.publishedIn,
          actUrl: v.actUrl,
          sourceUrl: v.sourceUrl,
          sourceSha256: v.sourceSha256,
          consultedAt: dataCivil(v.consultedAt),
          validFrom: dataCivil(v.validFrom),
          validTo: v.validTo ? dataCivil(v.validTo) : null,
          notes: v.notes,
        },
      }));
    await db.notifiableCondition.createMany({
      data: v.conditions.map((x) => ({
        versionId: versao.id,
        key: x.key,
        groupKey: x.group,
        item: x.item,
        subitem: x.subitem,
        name: x.name,
        context: x.context,
        immediateMs: x.immediateMs,
        immediateSes: x.immediateSes,
        immediateSms: x.immediateSms,
        weekly: x.weekly,
        notifyOn: x.notifyOn,
        deadlineStart: x.deadlineStart,
        sensitive: x.sensitive,
        once: x.once,
        normativeStatus: x.normativeStatus,
        normativeNote: x.normativeNote,
        sinanCode: x.sinanCode,
      })),
      skipDuplicates: true,
    });
  }

  // ── População: RIPSA do município, Censo 2022 do município e, sintético, da localidade e do bairro da malha ──
  await db.populationEstimate.createMany({
    data: [
      ...Object.entries(POPULACAO_RIPSA_DEMO.anos).map(([ano, populacao]) => ({
        year: Number(ano),
        level: 'MUNICIPIO' as const,
        population: populacao,
        source: 'RIPSA' as const,
        version: POPULACAO_RIPSA_DEMO.versao,
        notes: POPULACAO_RIPSA_DEMO.nota,
        createdBy: vera,
      })),
      { year: 2022, level: 'MUNICIPIO' as const, population: CENSO_2022_DEMO.municipio, source: 'CENSO_2022' as const, notes: CENSO_2022_DEMO.notaMunicipio, createdBy: vera },
      ...(sede ? [{ year: 2022, level: 'LOCALIDADE' as const, territoryId: sede.id, population: CENSO_2022_DEMO.localidade, source: 'CENSO_2022' as const, notes: CENSO_2022_DEMO.notaSintetica, createdBy: vera }] : []),
      ...(centro ? [{ year: 2022, level: 'BAIRRO' as const, territoryId: centro.id, population: CENSO_2022_DEMO.bairro, source: 'CENSO_2022' as const, notes: CENSO_2022_DEMO.notaSintetica, createdBy: vera }] : []),
    ],
  });

  // ── Receita do diagrama da dengue: modelo do MS 2025 com a população RIPSA ──
  await db.diagramSetting.create({
    data: { groupKey: 'dengue', recipe: { ...RECEITAS_MODELO.MS_2025.receita }, excludedYears: [], populationSource: 'RIPSA', populationVersion: POPULACAO_RIPSA_DEMO.versao, updatedBy: vera },
  });

  // ── Unidades notificantes e responsáveis pelo atesto ──
  const notificantes = UNITS.filter((u) => !FORA_DA_NEGATIVA.includes(u.type));
  await db.notifyingUnit.createMany({ data: notificantes.map((u) => ({ unitId: c.unit[u.key], since: dataCivil(inicioDemo), createdBy: vera, createdAt: as(inicioDemo, 8) })) });
  await db.notifyingUnitResponsible.createMany({
    data: RESPONSAVEIS_NEGATIVA_DEMO.map((r) => ({ unitId: c.unit[r.unidade], userId: c.staff[r.pessoa]!, kind: r.tipo, since: dataCivil(inicioDemo), designatedBy: vera, designatedAt: as(inicioDemo, 10) })),
  });
  const lotacao = (pessoa: string, u: UnitKey) => db.userAssignment.findFirstOrThrow({ where: { userId: c.staff[pessoa]!, unitId: c.unit[u] }, select: { role: true, cbo: true } });

  // ── Notificações do OmniSaúde (dengue e coqueluche) ──
  const seqs = new Map<number, number>();
  const proximoNumero = async (ano: number) => {
    const ultimo = seqs.get(ano) ?? (await db.notification.findFirst({ where: { year: ano }, orderBy: { seq: 'desc' }, select: { seq: true } }))?.seq ?? 0;
    seqs.set(ano, ultimo + 1);
    return ultimo + 1;
  };
  const notificacoes: { spec: (typeof NOTIFICACOES_DEMO)[number]; id: string; sintomas: string; semanaSint: string; semanaNot: string; diaNot: string; notificadaEm: Date }[] = [];
  for (const [i, n] of NOTIFICACOES_DEMO.entries()) {
    const semana = deslocarSemana(sem.atual, n.semana);
    const sintomas = diaDa(semana, n.sintomas);
    const conhecidoEm = noPassado(as(diaDa(semana, n.conhecimento), 9 + (i % 3), (i * 10) % 60));
    const notificadaEm = noPassado(new Date(conhecidoEm.getTime() + 2 * 3_600_000));
    const diaNot = localDateString(notificadaEm, tz);
    const vigente = versaoNaData(LNNC_NACIONAL, localDateString(conhecidoEm, tz))!.versao;
    const condicao = await db.notifiableCondition.findFirstOrThrow({ where: { key: n.grupo, version: { nationalId: vigente.id } } });
    const prazo = calcularPrazo(condicao, { atendimento: null, conhecimento: conhecidoEm, confirmacao: null });
    const paciente = await db.patient.findUniqueOrThrow({ where: { id: c.patient[n.paciente]! }, include: { family: { include: { household: true } } } });
    const casa = paciente.family?.household ?? null;
    const autor = await db.user.findUniqueOrThrow({ where: { id: c.staff[n.notificador]! }, select: { name: true, socialName: true } });
    const lot = await lotacao(n.notificador, n.unidade);
    const idade = idadeSinan(paciente.birthDate, conhecidoEm);
    const fertil = idade.unidade === 'A' && idade.valor >= 10 && idade.valor <= 49;
    const geo = casa?.latitude != null && casa.longitude != null ? { lat: casa.latitude, lng: casa.longitude } : null;
    // Retrato da Ficha Individual de Notificação do Sinan Net v5, como a API monta e confirma.
    const ficha = {
      formVersion: 'SINAN_NET_FIN_V5',
      TP_NOT: '2',
      ID_AGRAVO: { nome: condicao.name, cid: null, item: condicao.item, subitem: condicao.subitem },
      DT_NOTIFIC: diaNot,
      SG_UF_NOT: c.uf,
      ID_MUNICIP: c.ibgeCode,
      ID_UNIDADE: { cnes: unidade(n.unidade).cnes, nome: unidade(n.unidade).name },
      DT_SIN_PRI: sintomas,
      NM_PACIENT: paciente.name,
      DT_NASC: paciente.birthDate.toISOString().slice(0, 10),
      NU_IDADE_N: idade,
      CS_SEXO: paciente.sex === 'M' || paciente.sex === 'F' ? paciente.sex : 'I',
      CS_GESTANT: paciente.sex === 'F' && fertil ? '5' : '6',
      CS_RACA: RACA_SINAN[paciente.racaCor] ?? '9',
      CS_ESCOL_N: idade.unidade === 'A' && idade.valor >= 7 ? '9' : '10',
      ID_CNS_SUS: paciente.cns,
      NM_MAE_PAC: paciente.motherName,
      SG_UF: c.uf,
      ID_MN_RESI: paciente.ibgeCode,
      ID_DISTRIT: null,
      NM_BAIRRO: paciente.district,
      NM_LOGRADO: paciente.street,
      NU_NUMERO: paciente.number,
      NM_COMPLEM: paciente.complement,
      ID_GEO1: geo?.lat ?? null,
      ID_GEO2: geo?.lng ?? null,
      NM_REFEREN: null,
      NU_CEP: paciente.cep,
      NU_TELEFON: paciente.phone,
      CS_ZONA: null,
      ID_PAIS: null,
      notificador: { nome: autor.socialName ?? autor.name, cbo: lot.cbo, funcao: lot.role },
    };
    const ano = Number(localDateString(conhecidoEm, tz).slice(0, 4));
    const seq = await proximoNumero(ano);
    const sistema = n.grupo === 'dengue' ? ('SINAN_ONLINE' as const) : ('SINAN_NET' as const);
    const semanaNot = semanaDaData(diaNot).codigo;
    // Imediata (coqueluche): ciência da vigilância municipal e repasse à SES por telefone, dentro das 24 h.
    const imediata = prazo.tipo === 'IMEDIATA';
    const ciencia = noPassado(new Date(notificadaEm.getTime() + 3_600_000));
    const repasse = noPassado(new Date(notificadaEm.getTime() + 3 * 3_600_000));
    const criada = await db.notification.create({
      data: {
        year: ano,
        seq,
        number: `${ano}/${String(seq).padStart(6, '0')}`,
        status: 'NOTIFICADA',
        origin: 'MANUAL',
        conditionId: condicao.id,
        conditionKey: condicao.key,
        groupKey: condicao.groupKey,
        basis: 'SUSPEITA',
        patientId: paciente.id,
        unitId: c.unit[n.unidade],
        notifierId: c.staff[n.notificador]!,
        notifierCbo: lot.cbo,
        notifierRole: lot.role,
        knownAt: conhecidoEm,
        deadlineStart: prazo.marco,
        deadlineKind: prazo.tipo,
        targets: prazo.esferas,
        deadlineStartAt: prazo.inicio,
        dueAt: prazo.vence,
        notifiedAt: notificadaEm,
        symptomsOnset: dataCivil(sintomas),
        epiWeekNotified: semanaNot,
        epiWeekOnset: semanaDaData(sintomas).codigo,
        sensitive: condicao.sensitive,
        form: ficha,
        residenceIbge: paciente.ibgeCode,
        residenceLat: geo?.lat ?? null,
        residenceLng: geo?.lng ?? null,
        residencePrecision: geo ? (casa?.geoPrecision ?? null) : null,
        outOfMunicipality: !!paciente.ibgeCode && paciente.ibgeCode !== c.ibgeCode,
        officialSystem: sistema,
        entryStatus: 'PENDENTE',
        smsReceivedAt: imediata ? ciencia : null,
        smsReceivedBy: imediata ? vera : null,
        createdBy: c.staff[n.notificador]!,
        createdAt: conhecidoEm,
        events: {
          create: [
            { kind: 'CRIADA_MANUAL', at: conhecidoEm, userId: c.staff[n.notificador]!, data: { origem: 'MANUAL', codigo: null, mapeamento: null } },
            { kind: 'CONFIRMADA', at: notificadaEm, userId: c.staff[n.notificador]!, data: { semana: semanaNot, sistema } },
            ...(imediata
              ? [
                  { kind: 'CIENCIA_SMS', at: ciencia, userId: vera },
                  { kind: 'COMUNICACAO', at: repasse, userId: vera, data: { esfera: 'SES', meio: 'TELEFONE' } },
                ]
              : []),
          ],
        },
        communications: {
          create: [
            { target: 'SMS', channel: 'SISTEMA', communicatedAt: notificadaEm, counterpartName: 'Vigilância epidemiológica municipal (painel do OmniSaúde)', userId: c.staff[n.notificador]! },
            ...(imediata && prazo.esferas.includes('SES')
              ? [{ target: 'SES' as const, channel: 'TELEFONE' as const, communicatedAt: repasse, counterpartName: 'CIEVS estadual (plantão)', protocol: `DEMO-${ano}-${seq}`, userId: vera }]
              : []),
          ],
        },
      },
    });
    notificacoes.push({ spec: n, id: criada.id, sintomas, semanaSint: semanaDaData(sintomas).codigo, semanaNot, diaNot, notificadaEm });
  }

  // ── Fatos por semana e unidade (notificação, surto ou registro oficial): a negativa só cabe sem eles ──
  const fatos = new Map<string, Set<UnitKey>>();
  const marcar = (semana: string, u: UnitKey) => (fatos.get(semana) ?? fatos.set(semana, new Set()).get(semana)!).add(u);
  for (const n of notificacoes) marcar(n.semanaNot, n.spec.unidade);
  const semanaSurto = semanaK(1);
  const diaSurto = diaDa(semanaSurto, SURTO_DEMO.diaConhecimento);
  marcar(semanaDaData(diaSurto).codigo, 'ubs');

  // ── Registros oficiais sintéticos (DENGON e CHIKON do Sinan Online) ──
  const series = seriesDemo(sem);
  // A notificação sem vínculo já conta na base consolidada: sai da contagem oficial da semana dos sintomas.
  const semVinculo = new Map<string, number>();
  for (const n of notificacoes) if (n.spec.grupo === 'dengue' && (n.spec.vinculo === 'SO_OMNISAUDE' || n.spec.vinculo === 'SUGESTAO')) semVinculo.set(n.semanaSint, (semVinculo.get(n.semanaSint) ?? 0) + 1);
  const correspondentes = notificacoes.filter((n) => n.spec.vinculo === 'CASADA' || n.spec.vinculo === 'CASADA_DIVERGENTE' || n.spec.vinculo === 'SUGESTAO');
  const provaveisAnalise = series.find((s) => s.grupo === 'dengue' && s.ano === sem.anoAnalise)!.provaveis.reduce((t, n, i) => (`${sem.anoAnalise}${doisDigitos(i + 1)}` <= sem.ultimaCompleta ? t + n : t), 0);
  const graves = gravesDemo(provaveisAnalise);
  const nomes = NOMES_SINTETICOS;
  const registros: RegistroDemo[] = [];
  let i = 0;
  for (const serie of series) {
    for (let s = 1; s <= 53; s++) {
      const semana = `${serie.ano}${doisDigitos(s)}`;
      const provaveis = Math.max(0, serie.provaveis[s - 1]! - (serie.grupo === 'dengue' ? (semVinculo.get(semana) ?? 0) : 0));
      const total = provaveis + serie.descartados[s - 1]!;
      for (let j = 0; j < total; j++, i++) {
        const dow = semana === sem.atual ? j % (domingoDeHoje + 1) : (j * 3 + s) % 7;
        const inicio = diaDa(semana, dow);
        const notificadoEm = ate(somarDias(inicio, (j + s) % 4));
        const sexo = i % 2 === 0 ? 'F' : 'M';
        const anoNasc = Math.min(serie.ano - 1, 1940 + ((i * 37) % 80));
        const r: RegistroDemo = {
          grupo: serie.grupo,
          inicio,
          notificadoEm,
          semanaNot: semanaDaData(notificadoEm).codigo,
          classificacao: null,
          criterio: null,
          evolucao: null,
          encerradoEm: null,
          obitoEm: null,
          unidade: null,
          bairro: nomes.bairros[i % 50 < 4 ? 0 : i % 50 < 7 ? 1 : i % 50 < 10 ? 2 : i % 50 < 12 ? 3 : i % 50 < 13 ? 4 : 5 + (i % 5)]!,
          nome: `${(sexo === 'F' ? nomes.femininos : nomes.masculinos)[(i >> 1) % 16]} ${nomes.sobrenomes[(i * 7) % 16]} ${nomes.sobrenomes[(i * 11 + 5) % 16]}`,
          nascimento: `${anoNasc}-${doisDigitos(1 + (i % 12))}-${doisDigitos(1 + (i % 28))}`,
          sexo,
          mae: `${nomes.femininos[(i * 3 + 1) % 16]} ${nomes.sobrenomes[(i * 5 + 2) % 16]}`,
          cns: null,
        };
        const confirmado = serie.grupo === 'dengue' ? '10' : '13';
        if (j >= provaveis) {
          // Descartado (CLASSI_FIN 5), encerrado em poucos dias.
          Object.assign(r, { classificacao: '5', criterio: i % 2 ? '1' : '2', encerradoEm: ate(somarDias(notificadoEm, 5)) });
        } else if (serie.ano < sem.anoAnalise) {
          const encerrado = ate(somarDias(notificadoEm, 25));
          if (serie.grupo === 'dengue' && i % 40 === 3) Object.assign(r, { classificacao: '8', encerradoEm: ate(somarDias(notificadoEm, 60)) });
          else if (serie.grupo === 'dengue' && i % 311 === 11) {
            // Dengue grave: metade evolui para óbito pelo agravo.
            const obito = i % 2 === 1;
            Object.assign(r, { classificacao: '12', criterio: '1', evolucao: obito ? '2' : '1', encerradoEm: encerrado, obitoEm: obito ? ate(somarDias(inicio, 6)) : null });
          } else Object.assign(r, { classificacao: serie.grupo === 'dengue' && i % 83 === 7 ? '11' : confirmado, criterio: i % 5 < 2 ? '1' : '2', evolucao: '1', encerradoEm: encerrado });
        } else if (somarDias(notificadoEm, 30) <= hoje) {
          // Ano em análise: encerrados os notificados há mais de 30 dias; os graves e com sinais de alarme ficam abaixo de 1%.
          let classe = confirmado;
          if (serie.grupo === 'dengue' && semana <= sem.ultimaCompleta && s >= 8) {
            if (graves.graves > 0) {
              classe = '12';
              graves.graves--;
            } else if (graves.sinaisAlarme > 0) {
              classe = '11';
              graves.sinaisAlarme--;
            }
          }
          Object.assign(r, { classificacao: classe, criterio: i % 5 < 2 ? '1' : '2', evolucao: '1', encerradoEm: ate(somarDias(notificadoEm, 30)) });
        }
        // Os registros que correspondem às notificações da demonstração: mesma pessoa, mesmas datas.
        if (serie.grupo === 'dengue' && j === 0 && provaveis > 0) {
          const n = correspondentes.find((x) => x.semanaSint === semana && !registros.some((y) => y.notificacao === x.spec.chave));
          if (n) {
            const p = PATIENTS.find((x) => x.key === n.spec.paciente)!;
            Object.assign(r, {
              notificacao: n.spec.chave,
              inicio: n.sintomas,
              notificadoEm: n.spec.vinculo === 'SUGESTAO' ? ate(somarDias(n.diaNot, 1)) : n.diaNot,
              unidade: n.spec.unidade,
              nome: p.name,
              nascimento: p.birthDate,
              sexo: p.sex,
              mae: p.motherName,
              // Sem CNS na sugestão: o vínculo fica para a vigilância (nome, nascimento e sexo).
              cns: n.spec.vinculo === 'SUGESTAO' ? null : cnsFromBase(p.cnsBase),
              ...(n.spec.vinculo === 'CASADA_DIVERGENTE'
                ? { classificacao: '10', criterio: '1', evolucao: '1', encerradoEm: ate(somarDias(n.diaNot, 9)) }
                : { classificacao: null, criterio: null, evolucao: null, encerradoEm: null }),
            });
            r.semanaNot = semanaDaData(r.notificadoEm).codigo;
            marcar(r.semanaNot, n.spec.unidade);
          }
        }
        registros.push(r);
      }
    }
  }

  // Unidade de cada registro: a UPA notifica toda semana; a UBS Jardim das Flores, até silenciar; as demais em rodízio,
  // fora das semanas reservadas para a negativa.
  const permitida = (u: UnitKey, k: number) => {
    const s = NEGATIVA_DEMO.semRegistro[u];
    return !(s === 'todas' || s?.includes(Math.max(1, k)));
  };
  const exigida = (u: UnitKey, k: number) => {
    const e = NEGATIVA_DEMO.exigeRegistro[u];
    return e === 'todas' || !!e?.includes(k);
  };
  const RODIZIO: UnitKey[] = ['upa', 'ubs', 'hosp', 'upa', 'ubs2', 'poli', 'upa', 'ubs'];
  let vez = 0;
  for (const r of [...registros].sort((a, b) => a.semanaNot.localeCompare(b.semanaNot))) {
    if (r.unidade) continue;
    const k = kDa(r.semanaNot);
    if (k < 0) {
      r.unidade = RODIZIO[vez++ % RODIZIO.length]!;
      continue;
    }
    const ja = fatos.get(r.semanaNot) ?? new Set<UnitKey>();
    let u = (['upa', 'ubs2'] as UnitKey[]).find((x) => exigida(x, k) && permitida(x, k) && !ja.has(x));
    while (!u) {
      const candidata = RODIZIO[vez++ % RODIZIO.length]!;
      if (permitida(candidata, k)) u = candidata;
    }
    r.unidade = u;
    marcar(r.semanaNot, u);
  }

  // ── Negativas: atesto quando a unidade com responsável não tem fato na semana; NNEGANET das já digitadas ──
  const responsavel = (u: UnitKey, tipo: 'TITULAR' | 'SUBSTITUTO') => RESPONSAVEIS_NEGATIVA_DEMO.find((r) => r.unidade === u && r.tipo === tipo)?.pessoa ?? null;
  const atestos: { u: UnitKey; k: number; semana: string; pessoa: string }[] = [];
  const soNoSinan: { u: UnitKey; semana: string }[] = [];
  for (const un of notificantes) {
    for (let k = 1; k <= NEGATIVA_DEMO.semanas; k++) {
      const semana = semanaK(k);
      if (fatos.get(semana)?.has(un.key)) continue;
      if (NEGATIVA_DEMO.soNoSinan[un.key]?.includes(k)) soNoSinan.push({ u: un.key, semana });
      if (NEGATIVA_DEMO.semAtesto[un.key]?.includes(k)) continue;
      const pessoa = NEGATIVA_DEMO.substituto[un.key]?.includes(k) ? responsavel(un.key, 'SUBSTITUTO') : responsavel(un.key, 'TITULAR');
      if (pessoa) atestos.push({ u: un.key, k, semana, pessoa });
    }
  }
  const negativasSinan = [...atestos.filter((a) => !NEGATIVA_DEMO.naoDigitadas.includes(a.k)).map((a) => ({ u: a.u, semana: a.semana })), ...soNoSinan];

  // ── Importação APLICADA: arquivos por agravo e ano de notificação, mais as negativas do Sinan Net ──
  const importadoEm = noPassado(new Date(c.now.getTime() - 50 * 60_000));
  const arquivos = new Map<string, { tipo: 'DENGON' | 'CHIKON' | 'NNEGANET'; registros: number; de: string; ate: string }>();
  const somar = (nome: string, tipo: 'DENGON' | 'CHIKON' | 'NNEGANET', dia: string) => {
    const a = arquivos.get(nome) ?? arquivos.set(nome, { tipo, registros: 0, de: dia, ate: dia }).get(nome)!;
    a.registros++;
    if (dia < a.de) a.de = dia;
    if (dia > a.ate) a.ate = dia;
  };
  for (const r of registros) somar(`${r.grupo === 'dengue' ? 'DENGON' : 'CHIKON'}${r.notificadoEm.slice(0, 4)}.DBF`, r.grupo === 'dengue' ? 'DENGON' : 'CHIKON', r.notificadoEm);
  for (const n of negativasSinan) somar('NNEGANET.DBF', 'NNEGANET', intervaloDaSemana(Number(n.semana.slice(0, 4)), Number(n.semana.slice(4))).fim);
  const files = [...arquivos.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([nome, a]) => ({
      nome,
      tipo: a.tipo,
      sistema: a.tipo === 'NNEGANET' ? 'SINAN_NET' : 'SINAN_ONLINE',
      tipoRegistro: a.tipo === 'NNEGANET' ? 'NEGATIVA' : 'INDIVIDUAL',
      tamanhoBytes: 4_000 + a.registros * (a.tipo === 'NNEGANET' ? 120 : 1_180),
      registros: a.registros,
      codificacao: 'CP850',
      origemCodificacao: 'CABECALHO',
      agravos: a.tipo === 'DENGON' ? ['A90'] : a.tipo === 'CHIKON' ? ['A920'] : [],
      periodo: { de: a.de, ate: a.ate },
      identificado: a.tipo !== 'NNEGANET',
      ignorado: false,
      avisos: [],
    }));
  const lidos = registros.length + negativasSinan.length;
  const imp = await db.officialImport.create({
    data: {
      system: 'SINAN_ONLINE',
      status: 'APLICADA',
      fileName: IMPORTACAO_DEMO,
      sha256: sha256(`omnisaude:demonstracao:vig-1c:${sem.atual}`),
      sizeBytes: files.reduce((t, f) => t + f.tamanhoBytes, 0),
      files,
      periodFrom: dataCivil(new Date(inicioAnoEpidemiologico(sem.anoAnalise - ANOS_HISTORICO_DEMO)).toISOString().slice(0, 10)),
      periodTo: dataCivil(hoje),
      declaredPeriod: true,
      identified: true,
      counts: { lidos, novos: lidos, alterados: 0, iguais: 0, recusados: 0, duplicadosNoArquivo: 0, ausentesPrevistos: 0, motivosRecusa: {}, porTipo: { INDIVIDUAL: registros.length, NEGATIVA: negativasSinan.length } },
      warnings: ['Importação de demonstração: registros sintéticos, nenhum corresponde a pessoa real.'],
      createdBy: vera,
      createdAt: new Date(importadoEm.getTime() - 20 * 60_000),
      appliedBy: vera,
      appliedAt: importadoEm,
    },
  });

  const numeros = new Map<string, number>();
  const numeroOficial = (prefixo: number, ano: string) => {
    const k = `${prefixo}|${ano}`;
    const n = (numeros.get(k) ?? 0) + 1;
    numeros.set(k, n);
    return String(Number(ano.slice(2)) * 100_000 + prefixo + n);
  };
  const linhas = registros.map((r) => {
    const agravo = r.grupo === 'dengue' ? 'A90' : 'A920';
    const tipoArquivo = r.grupo === 'dengue' ? 'DENGON' : 'CHIKON';
    const numero = numeroOficial(r.grupo === 'dengue' ? 0 : 90_000, r.notificadoEm.slice(0, 4));
    r.numero = numero;
    const u = unidade(r.unidade!);
    const valores: Record<string, string | null> = {
      numero,
      notificadoEm: r.notificadoEm,
      semanaNotificacao: r.semanaNot,
      municipioNotificacao: municipio6,
      cnes: u.cnes,
      agravo,
      grupo: r.grupo,
      inicioSintomas: r.inicio,
      semanaSintomas: semanaDaData(r.inicio).codigo,
      municipioResidencia: municipio6,
      bairroNome: r.bairro,
      classificacao: r.classificacao,
      criterio: r.criterio,
      evolucao: r.evolucao,
      encerradoEm: r.encerradoEm,
      obitoEm: r.obitoEm,
      nome: r.nome,
      nascimento: r.nascimento,
      sexo: r.sexo,
      mae: normalizarNomePessoa(r.mae),
      cns: r.cns,
    };
    return {
      system: 'SINAN_ONLINE' as const,
      type: 'INDIVIDUAL' as const,
      naturalKey: chaveNatural({ sistema: 'SINAN_ONLINE', tipo: 'INDIVIDUAL', numero, notificadoEm: r.notificadoEm, municipio: municipio6, agravo, cnes: u.cnes }),
      number: numero,
      notifiedOn: dataCivil(r.notificadoEm),
      epiWeekNotified: r.semanaNot,
      municipalityIbge: municipio6,
      unitCnes: u.cnes,
      unitId: c.unit[r.unidade!],
      agravo,
      groupKey: r.grupo,
      symptomsOnset: dataCivil(r.inicio),
      epiWeekOnset: semanaDaData(r.inicio).codigo,
      residenceIbge: municipio6,
      neighborhoodName: r.bairro,
      finalClass: r.classificacao,
      criterion: r.criterio,
      evolution: r.evolucao,
      closedOn: r.encerradoEm ? dataCivil(r.encerradoEm) : null,
      deathOn: r.obitoEm ? dataCivil(r.obitoEm) : null,
      situation: situacaoOficial(agravo, r.classificacao, r.criterio),
      severity: gravidadeOficial(agravo, r.classificacao),
      patientName: r.nome,
      patientNameNorm: normalizarNomePessoa(r.nome) || null,
      birthDate: dataCivil(r.nascimento),
      sex: r.sexo,
      motherNameNorm: normalizarNomePessoa(r.mae) || null,
      cns: r.cns,
      data: { _fontes: Object.fromEntries(Object.entries(valores).flatMap(([k, v]) => (v ? [[k, tipoArquivo]] : []))) },
      contentHash: sha256(JSON.stringify(['SINAN_ONLINE', 'INDIVIDUAL', valores])),
      firstImportId: imp.id,
      lastImportId: imp.id,
      lastSeenAt: importadoEm,
      createdAt: importadoEm,
    };
  });
  const linhasSinan = negativasSinan.map((n) => {
    const u = unidade(n.u);
    const fim = intervaloDaSemana(Number(n.semana.slice(0, 4)), Number(n.semana.slice(4))).fim;
    const numero = numeroOficial(80_000, fim.slice(0, 4));
    const valores = { numero, notificadoEm: fim, semanaNotificacao: n.semana, municipioNotificacao: municipio6, cnes: u.cnes };
    return {
      system: 'SINAN_NET' as const,
      type: 'NEGATIVA' as const,
      naturalKey: chaveNatural({ sistema: 'SINAN_NET', tipo: 'NEGATIVA', numero, notificadoEm: fim, municipio: municipio6, agravo: null, cnes: u.cnes }),
      number: numero,
      notifiedOn: dataCivil(fim),
      epiWeekNotified: n.semana,
      municipalityIbge: municipio6,
      unitCnes: u.cnes,
      unitId: c.unit[n.u],
      situation: situacaoOficial(null, null),
      data: { _fontes: Object.fromEntries(Object.keys(valores).map((k) => [k, 'NNEGANET'])) },
      contentHash: sha256(JSON.stringify(['SINAN_NET', 'NEGATIVA', valores])),
      firstImportId: imp.id,
      lastImportId: imp.id,
      lastSeenAt: importadoEm,
      createdAt: importadoEm,
    };
  });
  for (let ini = 0; ini < linhas.length; ini += 1_000) await db.officialRecord.createMany({ data: linhas.slice(ini, ini + 1_000) });
  await db.officialRecord.createMany({ data: linhasSinan });

  // Pares casados pelo número oficial (o digitador informou o número na fila de digitação).
  for (const n of notificacoes.filter((x) => x.spec.vinculo === 'CASADA' || x.spec.vinculo === 'CASADA_DIVERGENTE')) {
    const r = registros.find((x) => x.notificacao === n.spec.chave);
    if (!r) continue;
    const linha = linhas[registros.indexOf(r)]!;
    const registro = await db.officialRecord.findUniqueOrThrow({ where: { system_type_naturalKey: { system: 'SINAN_ONLINE', type: 'INDIVIDUAL', naturalKey: linha.naturalKey } } });
    const digitadaEm = noPassado(new Date(n.notificadaEm.getTime() + DAY));
    await db.notification.update({
      where: { id: n.id },
      data: {
        entryStatus: 'DIGITADA',
        officialNumber: r.numero,
        enteredBy: vera,
        enteredAt: digitadaEm,
        events: { create: { kind: 'DIGITADA', at: digitadaEm, userId: vera, data: { sistema: 'SINAN_ONLINE', numero: r.numero!, lote: null } } },
      },
    });
    // Divergências do par, como a conciliação grava: situação, evolução e encerramento.
    const divergencias = [
      ...(registro.situation !== 'EM_INVESTIGACAO' ? [{ campo: 'situacao', oficial: registro.situation, omnisaude: 'EM_INVESTIGACAO' }] : []),
      ...(registro.evolution ? [{ campo: 'evolucao', oficial: registro.evolution, omnisaude: null }] : []),
      ...(registro.closedOn ? [{ campo: 'encerramento', oficial: registro.closedOn.toISOString().slice(0, 10), omnisaude: null }] : []),
    ];
    await db.officialRecord.update({ where: { id: registro.id }, data: { notificationId: n.id, matchMethod: 'NUMERO_OFICIAL', matchedAt: importadoEm, divergences: divergencias } });
  }

  // ── Atestos da negativa, casados com a negativa digitada no Sinan Net quando há ──
  const doSinan = new Map(
    (await db.officialRecord.findMany({ where: { type: 'NEGATIVA', lastImportId: imp.id }, select: { id: true, unitCnes: true, epiWeekNotified: true } })).map((r) => [
      `${porCnes.get(r.unitCnes ?? '')}|${r.epiWeekNotified}`,
      r.id,
    ]),
  );
  const nomesDe = new Map((await db.user.findMany({ where: { id: { in: atestos.map((a) => c.staff[a.pessoa]!) } }, select: { id: true, name: true, socialName: true } })).map((u) => [u.id, u.socialName ?? u.name]));
  const linhasAtesto = [];
  for (const a of atestos) {
    const lot = await lotacao(a.pessoa, a.u);
    const { inicio, fim } = intervaloDaSemana(Number(a.semana.slice(0, 4)), Number(a.semana.slice(4)));
    const seguinte = semanaK(a.k - 1);
    const atrasado = NEGATIVA_DEMO.atrasado[a.u]?.includes(a.k) ?? false;
    const em = noPassado(atrasado ? as(diaDa(seguinte, 2), 10, 20) : as(diaDa(seguinte, 1), 9, 10 + a.k));
    const nome = nomesDe.get(c.staff[a.pessoa]!)!;
    linhasAtesto.push({
      unitId: c.unit[a.u],
      epiWeek: a.semana,
      status: 'ATESTADA' as const,
      attestedBy: c.staff[a.pessoa]!,
      attestedAt: em,
      attesterName: nome,
      attesterRole: ROLE_LABELS[lot.role as Role] ?? lot.role,
      attesterCbo: /^\d{6}$/.test(lot.cbo) ? lot.cbo : null,
      declaration: textoDoAtesto({ unidade: unidade(a.u).name, cnes: unidade(a.u).cnes, semana: a.semana, inicio, fim, nome, funcao: `${ROLE_LABELS[lot.role as Role] ?? lot.role}, CBO ${lot.cbo}` }),
      late: em.getTime() > prazoDaNegativa(a.semana, cfg.negativa, tz).getTime(),
      officialRecordId: doSinan.get(`${a.u}|${a.semana}`) ?? null,
      createdAt: em,
    });
  }
  await db.negativeReport.createMany({ data: linhasAtesto });

  // ── Plano de contingência modelo do MS (2025) em vigor, com o acionamento NORMALIDADE desde o início do ano ──
  const definicao = JSON.parse(JSON.stringify(PLANO_MODELO_MS_2025)) as typeof PLANO_MODELO_MS_2025;
  const plano = await db.contingencyPlan.create({
    data: {
      scope: 'ARBOVIROSES',
      name: 'Plano de contingência das arboviroses (modelo do MS, 2025)',
      version: 1,
      status: 'VIGENTE',
      validFrom: dataCivil(inicioAno),
      source: 'Plano de Contingência Nacional para Dengue, Chikungunya e Zika (MS, 2025), Apêndice B (orientação para os planos municipais)',
      definition: definicao as object,
      createdBy: vera,
      createdAt: as(inicioAno, 9),
      updatedBy: vera,
    },
  });
  const acionamento = await db.contingencyActivation.create({
    data: {
      planId: plano.id,
      level: 'MUNICIPIO',
      stage: 'NORMALIDADE',
      startedOn: dataCivil(inicioAno),
      startedWeek: `${sem.anoAnalise}01`,
      justification: 'Início do ano epidemiológico: o município fica na normalidade (preparação) até os indicadores pedirem outro estágio.',
      indicators: [],
      decidedBy: vera,
      decidedAt: as(inicioAno, 10),
    },
  });
  const situacaoDaAcao = (descricao: string) =>
    /diagrama de controle|revisar o plano/.test(descricao)
      ? { status: 'FEITA', responsible: 'Vera Lúcia (vigilância epidemiológica)' }
      : /boletim semanal/.test(descricao)
        ? { status: 'EM_ANDAMENTO', responsible: 'Vera Lúcia (vigilância epidemiológica)', note: 'Boletim publicado toda segunda-feira no portal da prefeitura.' }
        : { status: 'PENDENTE' };
  await db.contingencyActionItem.createMany({
    data: definicao.acoes
      .filter((a) => a.estagio === 'NORMALIDADE')
      .map((a) => ({ activationId: acionamento.id, stage: a.estagio, axis: a.eixo, description: a.descricao, ...situacaoDaAcao(a.descricao), updatedBy: vera })),
  });
  // Critérios manuais respondidos na semana de referência (a última completa).
  const respondidoEm = noPassado(as(diaDa(semanaK(1), 2), 16));
  await db.contingencyInput.createMany({
    data: [
      {
        planId: plano.id,
        level: 'MUNICIPIO',
        epiWeek: sem.ultimaCompleta,
        criterionId: 'mob-rtpcr',
        met: false,
        note: 'Positividade do RT-PCR em 12% nas últimas 4 SE (LACEN; dado sintético).',
        answeredBy: vera,
        answeredAt: respondidoEm,
      },
      { planId: plano.id, level: 'MUNICIPIO', epiWeek: sem.ultimaCompleta, criterionId: 'mob-sorotipo', met: false, note: 'Sem sorotipo novo no município.', answeredBy: vera, answeredAt: respondidoEm },
    ],
  });

  // ── Surto de DTA aberto na escola, registrado pela vigilância municipal, com a planilha de acompanhamento ──
  const conhecidoSurto = noPassado(as(diaSurto, 8, 30));
  const anoSurto = Number(diaSurto.slice(0, 4));
  const seqSurto = ((await db.outbreak.findFirst({ where: { year: anoSurto }, orderBy: { seq: 'desc' }, select: { seq: true } }))?.seq ?? 0) + 1;
  const investigado = diaDa(semanaSurto, SURTO_DEMO.diaInvestigacao);
  const investigadoEm = noPassado(as(investigado, 15));
  const primeiro = diaDa(semanaSurto, SURTO_DEMO.diaSintomas);
  await db.outbreak.create({
    data: {
      year: anoSurto,
      seq: seqSurto,
      number: `${anoSurto}/${String(seqSurto).padStart(4, '0')}`,
      status: 'ABERTO',
      category: 'DTA',
      cid: SURTO_DEMO.cid,
      notifiedOn: dataCivil(diaSurto),
      knownAt: conhecidoSurto,
      dueAt: new Date(conhecidoSurto.getTime() + 24 * 3_600_000),
      esp: false,
      unitId: c.unit.ubs,
      notifierId: vera,
      firstSymptomsOn: dataCivil(primeiro),
      casesCount: SURTO_DEMO.casos,
      initialPlace: SURTO_DEMO.localInicial,
      occurrenceIbge: c.ibgeCode,
      localityId: sede?.id ?? null,
      neighborhoodId: centro?.id ?? null,
      address: SURTO_DEMO.endereco,
      reference: SURTO_DEMO.referencia,
      zone: '1',
      lat: SURTO_DEMO.lat,
      lng: SURTO_DEMO.lng,
      investigatedOn: investigado <= hoje ? dataCivil(investigado) : null,
      transmission: '2',
      vehicle: '1',
      observations: SURTO_DEMO.observacoes,
      investigatorName: 'Vera Lúcia Vigilância Epidemiológica',
      investigatorRole: 'Enfermeira da vigilância epidemiológica',
      dta: { ...SURTO_DEMO.dta },
      createdBy: vera,
      createdAt: conhecidoSurto,
      cases: {
        create: SURTO_DEMO.planilha.map((p, n) => ({
          caseNumber: n + 1,
          initials: p.iniciais,
          sex: p.sexo,
          ageText: p.idade,
          residenceIbge: c.ibgeCode,
          neighborhoodId: centro?.id ?? null,
          onsetOn: dataCivil(diaDa(semanaSurto, p.dia)),
          hospitalized: p.hospitalizado,
          died: false,
          createdBy: vera,
          createdAt: conhecidoSurto,
        })),
      },
      events: {
        create: [
          { kind: 'CRIADO', payload: { papel: 'VIGILANCIA_EPIDEMIOLOGICA', categoria: 'DTA', casos: SURTO_DEMO.casos, assinatura: null }, byUser: vera, at: conhecidoSurto },
          ...SURTO_DEMO.planilha.map((_, n) => ({ kind: 'CASO_VINCULADO', payload: { caso: n + 1, manual: true }, byUser: vera, at: conhecidoSurto })),
          {
            kind: 'COMUNICADO',
            payload: {
              alvo: 'SES',
              canal: 'TELEFONE',
              contraparte: 'CIEVS estadual (plantão)',
              protocolo: `DEMO-SURTO-${anoSurto}-${seqSurto}`,
              nota: 'Repasse do surto em escola (DTA).',
              em: noPassado(new Date(conhecidoSurto.getTime() + 2 * 3_600_000)).toISOString(),
            },
            byUser: vera,
            at: noPassado(new Date(conhecidoSurto.getTime() + 2 * 3_600_000)),
          },
          ...(investigado <= hoje
            ? [{ kind: 'INVESTIGADO', payload: { campos: ['investigadoEm', 'modoTransmissao', 'veiculo', 'observacoes', 'dta'], investigadoEm: investigado }, byUser: vera, at: investigadoEm }]
            : []),
        ],
      },
    },
  });
}

export async function seedDemo(opts: SeedOptions) {
  const now = opts.now ?? new Date();
  const daysAgo = (n: number, hour = 9) => {
    const d = new Date(now.getTime() - n * DAY);
    d.setUTCHours(hour + 3, 0, 0, 0); // horário de Brasília (UTC-3)
    return d;
  };
  const daysAhead = (n: number, hour = 9) => daysAgo(-n, hour);

  if (opts.platformUser !== false) {
    await opts.master.platformUser.upsert({
      where: { email: DEMO_PLATFORM_EMAIL },
      update: {},
      create: { email: DEMO_PLATFORM_EMAIL, name: 'Operação da Plataforma', passwordHash: await hashPassword(DEMO_PASSWORD) },
    });
  }

  const { tenantId, dbName } = await provisionTenant(opts.master, opts.credentials, {
    ...DEMO_TENANT,
    slug: opts.slug ?? DEMO_TENANT.slug,
    cnpj: opts.slug && opts.slug !== DEMO_TENANT.slug ? `${DEMO_TENANT.cnpj.slice(0, 8)}${String(opts.slug.length).padStart(4, '0')}91` : DEMO_TENANT.cnpj,
    primaryHost: opts.primaryHost,
    primaryPort: opts.primaryPort,
    replicaHost: opts.replicaHost,
    replicaPort: opts.replicaPort,
    settings: { aiEnabled: true, whatsappEnabled: true, rndsEnabled: true, assistantEnabled: true, assistantName: 'Vida', ...opts.settings },
  });

  await opts.master.license.deleteMany({ where: { tenantId } });
  await opts.master.license.create({
    data: {
      tenantId,
      plan: 'demonstracao',
      modules: ['aps', 'urgencia', 'hospitalar', 'farmacia', 'faturamento', 'ia', 'whatsapp', 'libras', 'rnds'],
      seats: 200,
      validFrom: new Date('2026-01-01'),
    },
  });

  const cred = opts.credentials('default', 'oltp');
  const db: TenantClient = new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionUrl(opts.primaryHost, opts.primaryPort, dbName, cred) }),
  });

  try {
    if ((await db.unit.count()) > 0) return { tenantId, dbName, skipped: true };

    // ── Unidades e equipe ──
    const unit = {} as Record<UnitKey, string>;
    for (const u of UNITS) {
      const row = await db.unit.create({ data: { cnes: u.cnes, name: u.name, type: u.type, ibgeCode: DEMO_TENANT.ibgeCode } });
      unit[u.key] = row.id;
    }
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const staff = {} as Record<string, string>;
    for (const s of STAFF) {
      const row = await db.user.create({
        data: {
          cpf: s.cpf,
          cns: s.cns,
          name: s.name,
          email: `${s.key}@demo.omnisaude.dev`,
          passwordHash,
          assignments: {
            create: s.assignments.map((a) => ({ unitId: unit[a.unit], role: a.role, cbo: a.cbo, council: s.council ?? null })),
          },
        },
      });
      staff[s.key] = row.id;
    }

    // ── Pacientes ──
    const patient = {} as Record<string, string>;
    for (const p of PATIENTS) {
      const row = await db.patient.create({
        data: {
          cpf: completeCpf(p.cpfBase),
          cns: cnsFromBase(p.cnsBase),
          name: p.name,
          nameKey: personNameKey(p.name),
          motherName: p.motherName,
          birthDate: new Date(p.birthDate),
          sex: p.sex,
          racaCor: '03',
          phone: p.phone ?? null,
          whatsappOptIn: p.whatsapp ?? false,
          bolsaFamilia: p.key === 'luana' || p.key === 'fernanda',
          district: p.district,
          ibgeCode: DEMO_TENANT.ibgeCode,
          cep: '01001000',
          street: 'Rua Exemplo',
          number: String(100 + PATIENTS.indexOf(p)),
          conditions: {
            create: (p.conditions ?? []).map((c) => ({
              system: c.system,
              code: c.code,
              description: c.description,
              lineOfCare: c.line ?? null,
              onsetAt: new Date('2018-01-01'),
            })),
          },
          allergies: { create: (p.allergies ?? []).map((substance) => ({ substance, reaction: 'Urticária', severity: 'MODERADA' })) },
        },
      });
      patient[p.key] = row.id;
    }

    // ── Equipes (INE) e domicílios vinculados: base dos indicadores do cofinanciamento da APS ──
    const esf = await db.team.create({
      data: {
        ine: '0000000101',
        name: 'ESF Centro I',
        typeCode: '70',
        unitId: unit.ubs,
        area: '01',
        modality: 'ESF_40H',
        members: {
          create: [
            { userId: staff.enfermeiro!, cbo: '223505', microArea: '01' },
            { userId: staff.medica!, cbo: '225125' },
            { userId: staff.acs!, cbo: '515105', microArea: '01' },
          ],
        },
      },
    });
    await db.team.create({ data: { ine: '0000000102', name: 'Saúde Bucal Centro', typeCode: '71', unitId: unit.ubs, modality: 'ESB_I', members: { create: [{ userId: staff.dentista!, cbo: '223208' }] } } });
    await db.team.create({ data: { ine: '0000000103', name: 'eMulti Centro', typeCode: '72', unitId: unit.ubs, modality: 'EMULTI_ESTRATEGICA', members: { create: [{ userId: staff.social!, cbo: '251605' }] } } });
    // Coordenadas em torno do centro de Gurupi/TO para o mapa do território do ACS.
    const households: string[] = [];
    for (const p of PATIENTS) {
      const i = PATIENTS.indexOf(p);
      const household = await db.household.create({
        data: {
          cep: '01001000',
          street: 'Rua Exemplo',
          number: String(100 + i),
          district: p.district,
          ibgeCode: DEMO_TENANT.ibgeCode,
          latitude: -11.7292 + (i % 4) * 0.0012 - 0.002,
          longitude: -49.0686 + Math.floor(i / 4) * 0.0015 - 0.002,
          // Posição lida em campo (território, semana 25): liga ao quarteirão quando a malha for importada.
          geoPrecision: 'GPS_CAMPO',
          geoSource: 'seed',
          geoAt: new Date(),
          dwellingType: '01',
          tenure: '01',
          waterSupply: '01',
          sewage: '01',
          garbage: '01',
          electricity: true,
          rooms: 4,
          microArea: '01',
          unitId: unit.ubs,
          teamId: esf.id,
          families: { create: { responsibleId: patient[p.key]!, incomeBracket: '02' } },
        },
        include: { families: true },
      });
      await db.patient.update({ where: { id: patient[p.key]! }, data: { familyId: household.families[0]!.id, kinship: '00' } });
      households.push(household.id);
    }
    // Visitas do agente comunitário (microárea 01): uma realizada, uma com a pessoa ausente.
    await db.homeVisit.create({
      data: {
        unitId: unit.ubs,
        teamId: esf.id,
        professionalId: staff.acs!,
        cbo: '515105',
        householdId: households[0]!,
        patientId: patient[PATIENTS[0]!.key]!,
        visitedAt: daysAgo(12, 9),
        recordedAt: daysAgo(12, 9),
        turno: 1,
        outcome: '1',
        reasons: ['29', '11'],
        microArea: '01',
        systolic: 138,
        diastolic: 88,
        latitude: -11.7312,
        longitude: -49.0706,
      },
    });
    await db.homeVisit.create({
      data: {
        unitId: unit.ubs,
        teamId: esf.id,
        professionalId: staff.acs!,
        cbo: '515105',
        householdId: households[1]!,
        visitedAt: daysAgo(5, 15),
        recordedAt: daysAgo(5, 15),
        turno: 2,
        outcome: '3',
        reasons: ['29'],
        microArea: '01',
      },
    });

    // ── Estoque ──
    const location = {
      alm: (await db.stockLocation.create({ data: { unitId: unit.alm, name: 'Almoxarifado Central', kind: 'ALMOXARIFADO_CENTRAL' } })).id,
      fc: (await db.stockLocation.create({ data: { unitId: unit.fc, name: 'Farmácia Central', kind: 'FARMACIA_CENTRAL' } })).id,
      ubs: (await db.stockLocation.create({ data: { unitId: unit.ubs, name: 'Farmácia da UBS Centro', kind: 'FARMACIA_SETORIAL' } })).id,
      upa: (await db.stockLocation.create({ data: { unitId: unit.upa, name: 'Farmácia da UPA', kind: 'FARMACIA_SETORIAL' } })).id,
      hosp: (await db.stockLocation.create({ data: { unitId: unit.hosp, name: 'Farmácia Hospitalar', kind: 'FARMACIA_SETORIAL' } })).id,
      posto: (await db.stockLocation.create({ data: { unitId: unit.hosp, name: 'Posto de Enfermagem - Clínica Médica', kind: 'POSTO_ENFERMAGEM' } })).id,
    };
    const product = {} as Record<string, string>;
    const lot = {} as Record<string, string>;
    for (const [i, p] of PRODUCTS.entries()) {
      const row = await db.product.create({
        data: {
          code: p.code,
          description: p.description,
          activeIngredient: p.activeIngredient,
          unit: p.unit,
          gtin: p.gtin,
          controlledList: 'controlledList' in p ? p.controlledList : null,
          highAlert: 'highAlert' in p ? p.highAlert : false,
          antimicrobialRestricted: 'antimicrobialRestricted' in p ? p.antimicrobialRestricted : false,
          mappings: { create: { supplierCnpj: '11111111000191', supplierCode: `FORN-${p.code}`, gtin: p.gtin, conversionFactor: 1 } },
        },
      });
      product[p.code] = row.id;
      const l = await db.stockLot.create({
        data: {
          productId: row.id,
          lotNumber: `L26${String(i + 1).padStart(3, '0')}`,
          expiry: new Date(`2027-${String((i % 12) + 1).padStart(2, '0')}-28`),
          manufacturer: 'Laboratório Exemplo S.A.',
        },
      });
      lot[p.code] = l.id;
      for (const [loc, qty] of [
        [location.alm, 5000],
        [location.fc, 1200],
        [location.ubs, 300],
        [location.upa, 200],
        [location.hosp, 400],
      ] as const) {
        await db.stockBalance.create({ data: { locationId: loc, lotId: l.id, quantity: qty } });
        await db.stockMovement.create({
          data: { kind: 'AJUSTE', locationId: loc, lotId: l.id, quantity: qty, refType: 'CARGA_INICIAL', userId: staff.farmaceutica! },
        });
      }
    }

    // ── Sala de vacina da UBS Centro: produtos (imunobiológicos), lotes e saldos ──
    const salaVacina = (await db.stockLocation.create({ data: { unitId: unit.ubs, name: 'Sala de Vacina - UBS Centro', kind: 'SALA_DE_VACINA' } })).id;
    for (const [i, v] of VACCINES.entries()) {
      const row = await db.product.create({ data: { code: v.code, description: v.description, unit: v.unit, vaccineCode: v.vaccineCode, pharmaceuticalForm: 'Suspensão injetável' } });
      const l = await db.stockLot.create({ data: { productId: row.id, lotNumber: `V26${String(i + 1).padStart(3, '0')}`, expiry: new Date(now.getTime() + (180 + i * 15) * DAY), manufacturer: v.manufacturer } });
      await db.stockBalance.create({ data: { locationId: salaVacina, lotId: l.id, quantity: 50 } });
      await db.stockMovement.create({ data: { kind: 'AJUSTE', locationId: salaVacina, lotId: l.id, quantity: 50, refType: 'CARGA_INICIAL', userId: staff.enfermeiro! } });
    }

    // ── Depósito de endemias da Vigilância em Saúde: larvicidas por lote (VIG-3a) ──
    const endemias = (await db.stockLocation.create({ data: { unitId: unit.vig, name: 'Depósito de Endemias', kind: 'ENDEMIAS' } })).id;
    for (const l of LARVICIDES) {
      const row = await db.product.create({
        data: { code: l.code, description: l.description, activeIngredient: l.activeIngredient, concentration: l.concentration, pharmaceuticalForm: l.pharmaceuticalForm, unit: l.unit, vectorControl: 'LARVICIDA' },
      });
      for (const lote of l.lots) {
        const sl = await db.stockLot.create({ data: { productId: row.id, lotNumber: lote.lotNumber, expiry: new Date(now.getTime() + lote.expiryDays * DAY), manufacturer: 'Fornecido pelo Ministério da Saúde (SIES)' } });
        await db.stockBalance.create({ data: { locationId: endemias, lotId: sl.id, quantity: lote.quantity } });
        await db.stockMovement.create({ data: { kind: 'AJUSTE', locationId: endemias, lotId: sl.id, quantity: lote.quantity, refType: 'CARGA_INICIAL', userId: staff.coordenador! } });
      }
    }
    if (opts.territorioDemo) await territorioDemo(db, { households, unitVig: unit.vig, ace: staff.ace!, coordenador: staff.coordenador! });

    // ── Leitos ──
    const wards = [
      { unit: unit.hosp, name: 'Clínica Médica', kind: 'CLINICA_MEDICA', prefix: 'CM', beds: 10 },
      { unit: unit.hosp, name: 'Clínica Cirúrgica', kind: 'CIRURGICA', prefix: 'CC', beds: 6 },
      { unit: unit.hosp, name: 'UTI Adulto', kind: 'UTI_ADULTO', prefix: 'UTI', beds: 5 },
      { unit: unit.hosp, name: 'Pediatria', kind: 'PEDIATRIA', prefix: 'PED', beds: 4 },
      { unit: unit.upa, name: 'Observação UPA', kind: 'OBSERVACAO', prefix: 'OBS', beds: 6 },
    ] as const;
    const bedIds: Record<string, string> = {};
    for (const w of wards) {
      const ward = await db.ward.create({ data: { unitId: w.unit, name: w.name, kind: w.kind } });
      for (let i = 1; i <= w.beds; i++) {
        const code = `${w.prefix}-${String(i).padStart(2, '0')}`;
        const status = code === 'CM-05' || code === 'UTI-02' ? 'HIGIENIZACAO' : code === 'CC-06' ? 'BLOQUEADO' : 'VAGO';
        const isolation = code === 'CM-08' ? 'CONTATO' : 'NENHUM';
        bedIds[code] = (await db.bed.create({ data: { wardId: ward.id, code, status, isolation } })).id;
      }
    }

    // ── SIGTAP (amostra) e POPs ──
    const comp = competencia(now);
    for (const s of SIGTAP_SAMPLE) {
      await db.sigtapProcedure.create({
        data: {
          code: s.code,
          name: s.name,
          sex: s.sex,
          minAgeMonths: s.minAgeMonths,
          maxAgeMonths: s.maxAgeMonths,
          maxQuantity: s.maxQuantity,
          valueSa: s.valueSa,
          instruments: [...s.instruments],
          competencia: comp,
        },
      });
      await db.sigtapProcedureCbo.createMany({ data: s.cbos.map((cbo) => ({ procedureCode: s.code, cbo })) });
      if (s.cids.length) await db.sigtapProcedureCid.createMany({ data: s.cids.map((cid) => ({ procedureCode: s.code, cid })) });
    }
    await db.sigtapSync.create({ data: { competencia: comp, source: 'AMOSTRA_DEMONSTRACAO', status: 'CONCLUIDA', procedures: SIGTAP_SAMPLE.length, finishedAt: now } });
    for (const p of POPS) {
      await db.pop.create({
        data: { code: p.code, title: p.title, kind: p.kind, trigger: p.trigger, content: p.content, checklist: p.checklist as unknown as object, requiresDoubleCheck: p.requiresDoubleCheck },
      });
    }

    // ── Histórico clínico ──
    const medica = staff.medica!;
    const pastVisit = async (key: string, when: Date, unitId: string, cid: string, soap: { s: string; o: string; a: string; p: string }) => {
      const enc = await db.encounter.create({
        data: {
          unitId,
          patientId: patient[key]!,
          kind: 'AMBULATORIAL',
          status: 'ENCERRADO',
          responsibleId: medica,
          mainCid: cid,
          outcome: 'ALTA',
          startedAt: when,
          endedAt: new Date(when.getTime() + 25 * 60_000),
          createdBy: staff.recepcao!,
        },
      });
      await db.$transaction(async (tx) => {
        const note = await tx.clinicalNote.create({
          data: {
            encounterId: enc.id,
            authorId: medica,
            role: 'MEDICO',
            cbo: '225125',
            kind: 'SOAP',
            subjective: soap.s,
            objective: soap.o,
            assessment: soap.a,
            plan: soap.p,
            codes: [cid],
          },
        });
        const { hash } = await appendAudit(tx, {
          userId: medica,
          unitId,
          role: 'MEDICO',
          ip: '10.0.0.10',
          mfa: true,
          action: 'prontuario.assinar',
          entityType: 'ClinicalNote',
          entityId: note.id,
          payload: { encounterId: enc.id, soap },
        });
        await tx.clinicalNote.update({ where: { id: note.id }, data: { status: 'ASSINADO', signedAt: when, auditHash: hash } });
      });
      return enc.id;
    };

    const hasSoap = {
      s: 'Retorno de hipertensão. Nega cefaleia ou dor torácica. Refere boa adesão à medicação.',
      o: 'PA 138 x 88 mmHg, FC 76 bpm. Ausculta cardíaca e pulmonar sem alterações.',
      a: 'Hipertensão arterial sistêmica controlada.',
      p: 'Manter hidroclorotiazida 25 mg 1x ao dia. Retorno em 3 meses com exames.',
    };
    await pastVisit('maria', new Date('2026-01-20T12:00:00Z'), unit.ubs, 'I10', hasSoap);
    await pastVisit('jose', new Date('2025-12-10T13:00:00Z'), unit.ubs, 'I10', hasSoap);
    await pastVisit('antonia', daysAgo(75), unit.ubs, 'I10', hasSoap);
    await pastVisit('francisco', new Date('2026-01-08T12:30:00Z'), unit.ubs2, 'I10', hasSoap);
    await pastVisit('fernanda', daysAgo(260), unit.ubs, 'E11', {
      s: 'Acompanhamento de diabetes e hipertensão.',
      o: 'PA 150 x 95 mmHg. Glicemia capilar 210 mg/dL.',
      a: 'DM2 e HAS descompensados.',
      p: 'Ajuste de metformina; solicitar HbA1c. Retorno em 30 dias.',
    });
    await pastVisit('sebastiao', daysAgo(150), unit.poli, 'C61', {
      s: 'Seguimento oncológico.',
      o: 'Bom estado geral.',
      a: 'Neoplasia de próstata em seguimento.',
      p: 'Retorno em 60 dias com PSA.',
    });
    await pastVisit('luana', daysAgo(45), unit.ubs, 'Z34', {
      s: 'Pré-natal, 20 semanas. Sem queixas.',
      o: 'PA 110 x 70 mmHg. Altura uterina compatível. BCF 140 bpm.',
      a: 'Gestação de baixo risco.',
      p: 'Retorno em 30 dias. Sulfato ferroso e ácido fólico.',
    });

    // Dispensações de hidroclorotiazida na Farmácia Central (casam com o exemplo de BI da especificação).
    for (const [key, date] of [
      ['maria', '2026-02-10T13:00:00Z'],
      ['jose', '2026-03-05T14:00:00Z'],
      ['antonia', '2026-02-18T15:00:00Z'],
      ['francisco', '2026-01-22T13:30:00Z'],
      ['maria', '2026-03-12T13:00:00Z'],
    ] as const) {
      await db.dispensation.create({
        data: {
          unitId: unit.fc,
          locationId: location.fc,
          patientId: patient[key]!,
          dispensedBy: staff.farmaceutica!,
          dispensedAt: new Date(date),
          items: { create: { productId: product.MED004!, lotId: lot.MED004!, quantity: 30 } },
        },
      });
    }

    // Exames: creatinina alterada da Raimunda (copiloto: metformina x função renal).
    await db.examRequest.create({
      data: {
        patientId: patient.raimunda!,
        requesterId: medica,
        sigtapCode: '0202010317',
        name: 'Dosagem de creatinina',
        analyte: 'CREATININA',
        status: 'RESULTADO',
        resultValue: 2.1,
        resultUnit: 'mg/dL',
        requestedAt: daysAgo(20),
        resultAt: daysAgo(15),
      },
    });

    // Prescrição em uso do Carlos (varfarina): o copiloto alerta ao prescrever AAS ou AINE.
    const carlosVisit = await pastVisit('carlos', daysAgo(30), unit.ubs, 'I48', {
      s: 'Fibrilação atrial em anticoagulação.',
      o: 'FC 82 bpm irregular. PA 130 x 80 mmHg.',
      a: 'FA permanente anticoagulada.',
      p: 'Manter varfarina 5 mg/dia; controle de INR.',
    });
    await db.prescription.create({
      data: {
        encounterId: carlosVisit,
        patientId: patient.carlos!,
        prescriberId: medica,
        kind: 'AMBULATORIAL',
        signedAt: daysAgo(30),
        items: { create: { productId: product.MED011!, description: 'Varfarina sódica 5 mg', activeIngredient: 'varfarina', dose: 5, doseUnit: 'mg', route: 'ORAL', frequencyHours: 24, durationDays: 90 } },
      },
    });

    // ── Agenda ──
    const schedule = await db.schedule.create({
      data: {
        unitId: unit.ubs,
        professionalId: medica,
        name: 'Clínica médica - Dra. Carla',
        cbo: '225125',
        slotMinutes: 20,
        rules: {
          create: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '07:00', endTime: '11:00', firstVisitQuota: 6, returnQuota: 6 })),
        },
      },
    });
    for (const [key, when, status] of [
      ['juliana', daysAhead(2, 8), 'AGENDADO'],
      ['maria', daysAhead(3, 9), 'AGENDADO'],
      ['jose', daysAhead(1, 7), 'CONFIRMADO'],
      ['fernanda', daysAgo(10, 8), 'FALTOU'],
    ] as const) {
      await db.appointment.create({
        data: {
          scheduleId: schedule.id,
          unitId: unit.ubs,
          patientId: patient[key]!,
          professionalId: medica,
          startsAt: when,
          endsAt: new Date(when.getTime() + 20 * 60_000),
          kind: key === 'juliana' ? 'PRIMEIRA_CONSULTA' : 'RETORNO',
          status,
          createdBy: staff.recepcao!,
        },
      });
    }

    // ── UPA hoje: fila classificada ──
    const today = localDateString(now);
    const upaArrival = async (key: string, seq: number, minutesAgo: number, triage?: Record<string, unknown>) => {
      const startedAt = new Date(now.getTime() - minutesAgo * 60_000);
      const ticket = await db.ticket.create({
        data: { unitId: unit.upa, day: today, sequence: seq, code: `N${String(seq).padStart(3, '0')}`, kind: 'NORMAL', patientId: patient[key]!, status: 'FINALIZADA', createdAt: startedAt },
      });
      const enc = await db.encounter.create({
        data: {
          unitId: unit.upa,
          patientId: patient[key]!,
          kind: 'URGENCIA',
          status: triage ? 'TRIADO' : 'ABERTO',
          ticketId: ticket.id,
          startedAt,
          createdBy: staff.recepcao!,
        },
      });
      await db.ticket.update({ where: { id: ticket.id }, data: { encounterId: enc.id } });
      if (triage) {
        await db.triage.create({
          data: {
            encounterId: enc.id,
            nurseId: staff.enfermeiro!,
            classifiedAt: new Date(startedAt.getTime() + 5 * 60_000),
            ...(triage as object),
          } as never,
        });
      }
    };
    await upaArrival('raimunda', 1, 50, {
      complaint: 'Tontura e mal-estar desde ontem',
      systolic: 150,
      diastolic: 90,
      heartRate: 96,
      spo2: 96,
      temperature: 36.8,
      glucose: 320,
      painScore: 2,
      suggestedColor: 'AMARELO',
      riskColor: 'AMARELO',
      painMap: [{ view: 'FRENTE', region: 'cabeca', x: 0.5, y: 0.08, intensity: 2 }],
      flags: [],
    });
    await upaArrival('carlos', 2, 30, {
      complaint: 'Dor no peito em aperto há 1 hora',
      systolic: 165,
      diastolic: 100,
      heartRate: 112,
      spo2: 95,
      temperature: 36.5,
      painScore: 7,
      suggestedColor: 'LARANJA',
      riskColor: 'LARANJA',
      painMap: [{ view: 'FRENTE', region: 'torax', x: 0.5, y: 0.3, intensity: 7 }],
      flags: ['dor_toracica'],
    });
    await upaArrival('thiago', 3, 10);

    // ── Internação: Francisco na Clínica Médica, com prescrição hospitalar e doses unitárias no posto ──
    const admEnc = await db.encounter.create({
      data: { unitId: unit.hosp, patientId: patient.francisco!, kind: 'INTERNACAO', status: 'EM_ATENDIMENTO', responsibleId: medica, mainCid: 'J18', startedAt: daysAgo(2), createdBy: staff.nir! },
    });
    await db.admission.create({ data: { encounterId: admEnc.id, patientId: patient.francisco!, bedId: bedIds['CM-03']!, mainCid: 'J18', admittedAt: daysAgo(2) } });
    await db.bed.update({ where: { id: bedIds['CM-03']! }, data: { status: 'OCUPADO' } });

    const hospRx = await db.prescription.create({
      data: {
        encounterId: admEnc.id,
        patientId: patient.francisco!,
        prescriberId: medica,
        kind: 'HOSPITALAR',
        signedAt: daysAgo(2),
        items: {
          create: [
            { productId: product.MED013!, description: 'Ceftriaxona 1 g IV', activeIngredient: 'ceftriaxona', dose: 1, doseUnit: 'g', route: 'IV', frequencyHours: 12, durationDays: 7 },
            { productId: product.MED017!, description: 'Heparina 5.000 UI SC', activeIngredient: 'heparina', dose: 5000, doseUnit: 'UI', route: 'SC', frequencyHours: 12, durationDays: 7 },
            { productId: product.MED019!, description: 'Dipirona 1 g IV se dor ou febre', activeIngredient: 'dipirona', dose: 1, doseUnit: 'g', route: 'IV', frequencyHours: 6, durationDays: 7 },
          ],
        },
      },
      include: { items: true },
    });
    let serial = 1;
    for (const item of hospRx.items) {
      const prod = PRODUCTS.find((p) => product[p.code] === item.productId)!;
      const lotRow = await db.stockLot.findUniqueOrThrow({ where: { id: lot[prod.code]! } });
      for (let i = 0; i < 4; i++) {
        const s = `DEMO${String(serial++).padStart(6, '0')}`;
        const expiry = lotRow.expiry.toISOString().slice(0, 10);
        await db.unitDose.create({
          data: {
            serial: s,
            productId: item.productId!,
            lotId: lotRow.id,
            gtin: prod.gtin,
            expiry: lotRow.expiry,
            locationId: location.posto,
            gs1: gs1HumanReadable({ gtin: prod.gtin, expiry, lot: lotRow.lotNumber, serial: s }),
            createdBy: staff.farmaceutica!,
          },
        });
      }
      await db.stockBalance.upsert({
        where: { locationId_lotId: { locationId: location.posto, lotId: lotRow.id } },
        update: { quantity: { increment: 4 } },
        create: { locationId: location.posto, lotId: lotRow.id, quantity: 4 },
      });
    }

    // ── Produção para faturamento (inclui inconsistências para a crítica pré-glosa) ──
    const prod = (data: { procedureCode: string; cbo: string; cid?: string; patientKey: string; professional: string; unitId: string; instrument: 'BPA_I' | 'BPA_C' }) =>
      db.productionRecord.create({
        data: {
          unitId: data.unitId,
          competencia: comp,
          patientId: patient[data.patientKey]!,
          professionalId: data.professional,
          cbo: data.cbo,
          procedureCode: data.procedureCode,
          cid: data.cid ?? null,
          performedAt: daysAgo(1),
          instrument: data.instrument,
        },
      });
    await prod({ procedureCode: '0301060061', cbo: '225125', cid: 'I10', patientKey: 'carlos', professional: medica, unitId: unit.upa, instrument: 'BPA_I' });
    await prod({ procedureCode: '0301060061', cbo: '225125', cid: 'R51', patientKey: 'raimunda', professional: medica, unitId: unit.upa, instrument: 'BPA_I' });
    await prod({ procedureCode: '0301060118', cbo: '223505', patientKey: 'raimunda', professional: staff.enfermeiro!, unitId: unit.upa, instrument: 'BPA_C' });
    // CBO incompatível: recepcionista lançando atendimento de urgência.
    await prod({ procedureCode: '0301060061', cbo: '422105', cid: 'R50', patientKey: 'thiago', professional: staff.recepcao!, unitId: unit.upa, instrument: 'BPA_I' });
    // CID incompatível com o procedimento.
    await prod({ procedureCode: '0301060061', cbo: '225125', cid: 'S82', patientKey: 'pedro', professional: medica, unitId: unit.upa, instrument: 'BPA_I' });
    // Sexo incompatível (coleta de citopatológico em paciente masculino).
    await prod({ procedureCode: '0201020033', cbo: '223505', patientKey: 'jose', professional: staff.enfermeiro!, unitId: unit.ubs, instrument: 'BPA_C' });

    // ── Busca ativa em andamento ──
    const sCase = await db.activeSearchCase.create({
      data: { patientId: patient.fernanda!, lineOfCare: 'DIABETES', status: 'EM_CONTATO', assignedTo: staff.social!, lastVisitAt: daysAgo(260), openedAt: daysAgo(5) },
    });
    await db.activeSearchContact.create({
      data: {
        caseId: sCase.id,
        channel: 'TELEFONE',
        outcome: 'Contato realizado',
        vulnerabilities: ['TRANSPORTE'],
        actions: [],
        notes: 'Paciente relata dificuldade de transporte até a UBS.',
        userId: staff.social!,
        at: daysAgo(4),
      },
    });

    // ── Regulação ambulatorial: agendas dos especialistas, prestadores com cotas e solicitações em situações diferentes ──
    for (const [key, name, cbo] of [
      ['cardiologista', 'Cardiologia - Dr. Lúcio', '225120'],
      ['oftalmologista', 'Oftalmologia - Dra. Marina', '225265'],
    ] as const) {
      await db.schedule.create({
        data: {
          unitId: unit.poli,
          professionalId: staff[key]!,
          name,
          cbo,
          slotMinutes: 20,
          rules: { create: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '08:00', endTime: '12:00', firstVisitQuota: 8, returnQuota: 4 })) },
        },
      });
    }
    const competenciaAtual = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const poliProvider = await db.regulationProvider.create({
      data: {
        name: 'Policlínica Municipal',
        kind: 'PROPRIO',
        unitId: unit.poli,
        cnes: '9000052',
        physicalCeiling: 600,
        quotas: {
          create: [
            { competencia: competenciaAtual, kind: 'CONSULTA', specialty: 'CARDIOLOGIA', quantity: 20, unitValue: 10 },
            { competencia: competenciaAtual, kind: 'CONSULTA', specialty: 'OFTALMOLOGIA', quantity: 30, unitValue: 10 },
            { competencia: competenciaAtual, kind: 'CONSULTA', specialty: 'ENDOCRINOLOGIA', quantity: 10, unitValue: 10 },
            { competencia: competenciaAtual, kind: 'CONSULTA', specialty: 'CARDIOLOGIA', quantity: 5, unitValue: 10, originUnitId: unit.ubs, notes: 'PPI: reserva da UBS Centro' },
          ],
        },
      },
    });
    await db.regulationProvider.create({
      data: {
        name: 'Clínica Conveniada Imagem',
        kind: 'CONTRATADO',
        cnpj: '12345678000190',
        contractNumber: 'CT-2026-014',
        contractStart: new Date(`${now.getUTCFullYear()}-01-01`),
        contractEnd: new Date(`${now.getUTCFullYear()}-12-31`),
        physicalCeiling: 300,
        financialCeiling: 45000,
        phone: '(63) 3312-0000',
        address: 'Av. Goiás, 1200, Centro',
        quotas: {
          create: [
            { competencia: competenciaAtual, kind: 'EXAME', specialty: 'MAMOGRAFIA', quantity: 150, unitValue: 45 },
            { competencia: competenciaAtual, kind: 'EXAME', specialty: 'USG_ABDOME', quantity: 80, unitValue: 24.2 },
            { competencia: competenciaAtual, kind: 'EXAME', specialty: 'ECOCARDIOGRAMA', quantity: 40, unitValue: 39.94 },
          ],
        },
      },
    });
    const cotaOftalmo = await db.regulationQuota.findFirst({ where: { providerId: poliProvider.id, specialty: 'OFTALMOLOGIA' } });
    const ano = now.getUTCFullYear();
    type RegData = Omit<Prisma.RegulationRequestUncheckedCreateInput, 'protocol' | 'unitId' | 'requesterId' | 'requesterCbo' | 'procedureCode' | 'requestedPriority' | 'events'> & {
      events: { kind: string; toStatus?: 'PENDENTE' | 'EM_ANALISE' | 'DEVOLVIDA' | 'AUTORIZADA' | 'NEGADA'; userId: string; role: 'MEDICO' | 'NIR'; notes?: string; at: Date }[];
    };
    const reg = async (n: number, { events, ...data }: RegData) =>
      db.regulationRequest.create({
        data: {
          ...data,
          protocol: `REG-${ano}-${String(n).padStart(6, '0')}`,
          unitId: unit.ubs,
          requesterId: medica,
          requesterCbo: '225125',
          procedureCode: data.kind === 'CONSULTA' ? '0301010072' : '0204030188',
          requestedPriority: data.priority,
          events: { create: events.map((e) => ({ kind: e.kind, toStatus: e.toStatus ?? null, userId: e.userId, role: e.role, notes: e.notes ?? null, at: e.at })) },
        },
      });
    await reg(1, {
      kind: 'CONSULTA',
      specialty: 'CARDIOLOGIA',
      procedureName: 'Consulta com Cardiologia',
      patientId: patient.maria!,
      priority: 'VERDE',
      clinicalSummary: 'Hipertensão arterial com PA acima da meta em uso de losartana, anlodipino e hidroclorotiazida em doses otimizadas há 6 meses. ECG com sobrecarga de VE.',
      criteria: ['HAS_RESISTENTE'],
      cid: 'I10',
      protocolIssues: ['Sem Creatinina nos últimos 12 meses'],
      status: 'PENDENTE',
      createdAt: daysAgo(10, 10),
      events: [{ kind: 'CRIADA', toStatus: 'PENDENTE', userId: medica, role: 'MEDICO', notes: 'Pendências do protocolo: Sem Creatinina nos últimos 12 meses', at: daysAgo(10, 10) }],
    });
    await reg(2, {
      kind: 'CONSULTA',
      specialty: 'OFTALMOLOGIA',
      procedureName: 'Consulta com Oftalmologia',
      patientId: patient.jose!,
      priority: 'VERDE',
      clinicalSummary: 'Diabetes há 8 anos sem fundoscopia registrada; queixa de visão embaçada progressiva.',
      criteria: ['RETINOPATIA_DM'],
      cid: 'E11',
      protocolIssues: [],
      status: 'AUTORIZADA',
      regulatorId: staff.nir!,
      decisionAt: daysAgo(3, 15),
      providerUnitId: unit.poli,
      providerId: poliProvider.id,
      quotaId: cotaOftalmo?.id ?? null,
      competencia: competenciaAtual,
      createdAt: daysAgo(14, 9),
      events: [
        { kind: 'CRIADA', toStatus: 'PENDENTE', userId: medica, role: 'MEDICO', at: daysAgo(14, 9) },
        { kind: 'EM_ANALISE', toStatus: 'EM_ANALISE', userId: staff.nir!, role: 'NIR', at: daysAgo(3, 14) },
        { kind: 'AUTORIZADA', toStatus: 'AUTORIZADA', userId: staff.nir!, role: 'NIR', notes: 'Unidade executante: Policlínica Municipal', at: daysAgo(3, 15) },
      ],
    });
    await reg(3, {
      kind: 'CONSULTA',
      specialty: 'ENDOCRINOLOGIA',
      procedureName: 'Consulta com Endocrinologia',
      patientId: patient.fernanda!,
      priority: 'AMARELA',
      priorityJustification: 'Hipoglicemias frequentes com insulina NPH, duas com necessidade de ajuda de terceiros no último mês.',
      clinicalSummary: 'Diabetes tipo 2 insulinizada, hipoglicemias de repetição apesar de redução de dose.',
      criteria: ['HIPOGLICEMIAS_GRAVES'],
      cid: 'E11',
      protocolIssues: ['Sem Hemoglobina glicada nos últimos 12 meses'],
      status: 'DEVOLVIDA',
      regulatorId: staff.nir!,
      decisionAt: daysAgo(1, 11),
      decisionReason: 'Anexar hemoglobina glicada e informar as doses atuais de insulina.',
      returnedCount: 1,
      createdAt: daysAgo(4, 16),
      events: [
        { kind: 'CRIADA', toStatus: 'PENDENTE', userId: medica, role: 'MEDICO', notes: 'Pendências do protocolo: Sem Hemoglobina glicada nos últimos 12 meses', at: daysAgo(4, 16) },
        { kind: 'DEVOLVIDA', toStatus: 'DEVOLVIDA', userId: staff.nir!, role: 'NIR', notes: 'Anexar hemoglobina glicada e informar as doses atuais de insulina.', at: daysAgo(1, 11) },
      ],
    });
    await reg(4, {
      kind: 'EXAME',
      specialty: 'MAMOGRAFIA',
      procedureName: 'Mamografia bilateral',
      patientId: patient.maria!,
      priority: 'AZUL',
      clinicalSummary: 'Rastreamento: 58 anos, sem mamografia há mais de 2 anos, sem queixas mamárias.',
      criteria: ['RASTREIO_50_69'],
      protocolIssues: [],
      status: 'PENDENTE',
      createdAt: daysAgo(40, 8),
      events: [{ kind: 'CRIADA', toStatus: 'PENDENTE', userId: medica, role: 'MEDICO', at: daysAgo(40, 8) }],
    });

    // ── Transporte sanitário e TFD ──
    const van = await db.vehicle.create({ data: { plate: 'QKA2B34', model: 'Fiat Ducato 2022', kind: 'VAN', seats: 12, wheelchair: true, odometerKm: 48200, nextMaintenanceKm: 50000, nextMaintenanceAt: daysAhead(45) } });
    await db.vehicle.create({ data: { plate: 'QKB5C67', model: 'Renault Master ambulância 2021', kind: 'AMBULANCIA_BASICA', seats: 2, odometerKm: 91300, nextMaintenanceKm: 92000 } });
    const motorista = await db.driver.create({ data: { name: 'Raimundo Costa Motorista', cpf: completeCpf('300000101'), phone: '(63) 99888-0101', cnh: '01234567890', cnhCategory: 'D', cnhExpiry: daysAhead(400) } });
    await db.driver.create({ data: { name: 'Eliane Souza Motorista', cnh: '09876543210', cnhCategory: 'D', cnhExpiry: daysAhead(20) } });
    const rota = await db.transportRoute.create({
      data: {
        name: 'Gurupi → Palmas (consultas e exames)',
        destinationCity: 'Palmas',
        destinationUf: 'TO',
        stops: [
          { nome: 'UBS Centro', endereco: 'Rua Exemplo, 100', horario: '04:30' },
          { nome: 'Rodoviária', endereco: 'Av. Goiás, s/n', horario: '04:45' },
        ],
        weekdays: [1, 3, 5],
        departureTime: '04:30',
        returnTime: '17:00',
        vehicleId: van.id,
      },
    });
    await db.vehicleLog.createMany({
      data: [
        { vehicleId: van.id, kind: 'ABASTECIMENTO', at: daysAgo(20), odometerKm: 47400, cost: 420, liters: 70, description: 'Diesel S10', userId: staff.nir! },
        { vehicleId: van.id, kind: 'ABASTECIMENTO', at: daysAgo(8), odometerKm: 48100, cost: 432, liters: 72, description: 'Diesel S10', userId: staff.nir! },
        { vehicleId: van.id, kind: 'MANUTENCAO', at: daysAgo(60), odometerKm: 45000, cost: 1850, description: 'Revisão de 45.000 km, pastilhas de freio', userId: staff.nir! },
      ],
    });
    const viagem = await db.transportTrip.create({
      data: {
        routeId: rota.id,
        vehicleId: van.id,
        driverId: motorista.id,
        date: daysAhead(2, 12),
        departureTime: '04:30',
        destinationCity: 'Palmas',
        destinationUf: 'TO',
        destinationPlace: 'Hospital Geral de Palmas',
        createdBy: staff.nir!,
      },
    });
    const tfd = await db.tfdProcess.create({
      data: {
        protocol: `TFD-${ano}-000001`,
        patientId: patient.maria!,
        unitId: unit.ubs,
        requesterId: medica,
        requesterCbo: '225125',
        cid: 'C50',
        diagnosis: 'Neoplasia maligna da mama em investigação',
        procedureName: 'Consulta em oncologia clínica e estadiamento',
        clinicalSummary: 'Nódulo mamário com biópsia positiva; necessita avaliação oncológica e estadiamento.',
        justification: 'Não há serviço de oncologia clínica no município nem na região de saúde.',
        urgency: true,
        destinationCity: 'Palmas',
        destinationUf: 'TO',
        destinationIbge: '1721000',
        destinationUnit: 'Hospital Geral de Palmas',
        transport: 'VEICULO_SANITARIO',
        needsCompanion: true,
        companionName: 'Benedita da Silva',
        companionRelation: 'Mãe',
        status: 'AGENDADO',
        sentAt: daysAgo(12, 10),
        opinionAt: daysAgo(6, 11),
        opinionBy: staff.nir!,
        opinionNotes: 'Deferido pela regional: consulta em oncologia no HGP.',
        allowanceApproved: true,
        appointmentAt: daysAhead(2, 11),
        appointmentPlace: 'Hospital Geral de Palmas, ambulatório de oncologia',
        allowance: [
          { tipo: 'DIARIA', beneficiario: 'PACIENTE', quantidade: 1, valorUnitario: 50 },
          { tipo: 'DIARIA', beneficiario: 'ACOMPANHANTE', quantidade: 1, valorUnitario: 50 },
        ],
        allowanceTotal: 100,
        tripId: viagem.id,
        createdAt: daysAgo(14, 9),
        events: {
          create: [
            { kind: 'ABERTO', toStatus: 'ABERTO', userId: medica, role: 'MEDICO', at: daysAgo(14, 9) },
            { kind: 'ENVIADO', fromStatus: 'ABERTO', toStatus: 'ENVIADO', userId: staff.social!, role: 'SERVICO_SOCIAL', notes: 'Processo enviado à regional de saúde.', at: daysAgo(12, 10) },
            { kind: 'DEFERIDO', fromStatus: 'ENVIADO', toStatus: 'DEFERIDO', userId: staff.nir!, role: 'NIR', notes: 'Deferido pela regional: consulta em oncologia no HGP.', at: daysAgo(6, 11) },
            { kind: 'AGENDADO', fromStatus: 'DEFERIDO', toStatus: 'AGENDADO', userId: staff.social!, role: 'SERVICO_SOCIAL', notes: 'Consulta marcada no HGP; vaga na viagem de segunda.', at: daysAgo(5, 15) },
          ],
        },
      },
    });
    await db.transportPassenger.create({
      data: {
        tripId: viagem.id,
        patientId: patient.maria!,
        companionName: 'Benedita da Silva',
        pickupAddress: 'Rua Exemplo, 100, Centro',
        appointmentAt: daysAhead(2, 11),
        appointmentPlace: 'HGP, ambulatório de oncologia',
        tfdId: tfd.id,
      },
    });
    await db.transportPassenger.create({
      data: { tripId: viagem.id, patientId: patient.jose!, pickupAddress: 'Rua Exemplo, 101, Centro', appointmentAt: daysAhead(2, 9), appointmentPlace: 'Hospital Geral de Palmas, oftalmologia', wheelchair: true },
    });

    // ── Central de leitos da rede e AIH (REG-7) ──
    const upaEnc = await db.encounter.findFirst({ where: { patientId: patient.thiago!, unitId: unit.upa, kind: 'URGENCIA' }, select: { id: true } });
    const vagaThiago = await db.bedRequest.create({
      data: {
        protocol: `LEI-${ano}-000001`,
        patientId: patient.thiago!,
        encounterId: upaEnc?.id ?? null,
        originUnitId: unit.upa,
        requesterId: medica,
        requesterCbo: '225125',
        bedKind: 'UTI_ADULTO',
        specialty: 'Cirurgia geral / trauma',
        priority: 'VERMELHA',
        requestedPriority: 'VERMELHA',
        cid: 'S821',
        clinicalSummary: 'Politrauma por acidente de moto com fratura exposta de tíbia e suspeita de lesão esplênica; hipotensão respondendo a volume.',
        vitals: { pas: 92, pad: 58, fc: 112, fr: 24, sato2: 92, temp: 36.4, consciencia: 'ALERTA', oxigenio: true },
        support: { oxigenio: true, drogaVasoativa: true },
        news2: 10,
        createdAt: daysAgo(0, 2),
      },
    });
    await db.bedRequestEvent.create({
      data: { requestId: vagaThiago.id, kind: 'CRIADA', toStatus: 'PENDENTE', userId: medica, role: 'MEDICO', notes: 'UTI adulto · Cirurgia geral / trauma · Emergência · NEWS2 10', at: daysAgo(0, 2) },
    });
    const vagaAntonia = await db.bedRequest.create({
      data: {
        protocol: `LEI-${ano}-000002`,
        patientId: patient.antonia!,
        originUnitId: unit.ubs,
        requesterId: medica,
        requesterCbo: '225125',
        bedKind: 'CLINICA_MEDICA',
        specialty: 'Clínica médica',
        priority: 'AMARELA',
        requestedPriority: 'VERDE',
        cid: 'E11',
        clinicalSummary: 'Descompensação diabética com hiperglicemia persistente (HGT > 400), desidratação e vômitos; sem resposta ao manejo ambulatorial.',
        vitals: { pas: 104, pad: 66, fc: 98, fr: 20, sato2: 96, temp: 37.2, consciencia: 'ALERTA', oxigenio: false },
        support: {},
        news2: 3,
        status: 'AUTORIZADA',
        regulatorId: staff.nir!,
        decisionAt: daysAgo(0, 1),
        decisionReason: 'Vaga na clínica médica; leito reservado. Transferir em veículo sanitário.',
        destinationUnitId: unit.hosp,
        destinationKind: 'CLINICA_MEDICA',
        reservedBedId: bedIds['CM-09']!,
        transport: 'VEICULO_SANITARIO',
        createdAt: daysAgo(0, 5),
      },
    });
    await db.bed.update({ where: { id: bedIds['CM-09']! }, data: { status: 'RESERVADO' } });
    await db.bedEvent.create({ data: { bedId: bedIds['CM-09']!, status: 'RESERVADO', isolation: 'NENHUM', reason: `Reserva LEI-${ano}-000002 (Clínica médica)`, userId: staff.nir!, at: daysAgo(0, 1) } });
    await db.bedRequestEvent.createMany({
      data: [
        { requestId: vagaAntonia.id, kind: 'CRIADA', toStatus: 'PENDENTE', userId: medica, role: 'MEDICO', notes: 'Clínica médica · Prioritária · NEWS2 3', at: daysAgo(0, 5) },
        { requestId: vagaAntonia.id, kind: 'EM_ANALISE', fromStatus: 'PENDENTE', toStatus: 'EM_ANALISE', userId: staff.nir!, role: 'NIR', at: daysAgo(0, 4) },
        {
          requestId: vagaAntonia.id,
          kind: 'AUTORIZADA',
          fromStatus: 'EM_ANALISE',
          toStatus: 'AUTORIZADA',
          userId: staff.nir!,
          role: 'NIR',
          notes: 'Hospital Municipal São Lucas · Clínica médica · leito reservado · Veículo sanitário · prioridade Prioritária → Urgência',
          at: daysAgo(0, 1),
        },
      ],
    });
    const faixa = await db.aihRange.create({ data: { name: `Faixa ${ano} · Hospital Municipal`, unitId: unit.hosp, uf: 'TO', year: ano, aihType: '1', seqStart: 1_000_001, seqEnd: 1_000_500, seqNext: 1_000_001 } });
    const admFrancisco = await db.admission.findFirst({ where: { patientId: patient.francisco!, dischargedAt: null } });
    if (admFrancisco) {
      await db.aihRequest.create({
        data: {
          patientId: patient.francisco!,
          admissionId: admFrancisco.id,
          unitId: unit.hosp,
          requesterId: medica,
          requesterCbo: '225125',
          procedureCode: '0303140151',
          procedureName: 'Tratamento de pneumonias ou influenza (gripe)',
          mainCid: 'J18',
          specialtyCode: '03',
          nature: '02',
          symptoms: 'Tosse produtiva, febre de 39 °C e dispneia há 4 dias.',
          conditions: 'Hipoxemia (SatO2 88% em ar ambiente) e comorbidade (DPOC): antibiótico venoso e oxigenoterapia.',
          diagnostics: 'RX de tórax com consolidação em lobo inferior direito; leucocitose com desvio.',
          rangeId: faixa.id,
          createdAt: daysAgo(2),
        },
      });
    }

    // ── Consolidação e detecção de surto (VIG-1c): depende da malha para o bairro e a localidade ──
    if (opts.consolidacaoDemo ?? opts.territorioDemo) await consolidacaoDemo(db, { now, timeZone: DEMO_TENANT.timeZone, ibgeCode: DEMO_TENANT.ibgeCode, uf: DEMO_TENANT.uf, unit, staff, patient });

    return { tenantId, dbName, skipped: false };
  } finally {
    await db.$disconnect();
  }
}
