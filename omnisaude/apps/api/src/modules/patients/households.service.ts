import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { avaliarGps, onlyDigits, type PrecisaoGeo } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { ENDERECO_LIGA_QUARTEIRAO, LocalizadorService, PRECISAO_LIGA_QUARTEIRAO } from '../territorio/localizador.service';
import { TerritorioService } from '../territorio/territorio.service';
import { patientSummary } from './patients.service';

export interface HouseholdInput {
  cep?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  uf?: string | null;
  ibgeCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Precisão da posição enviada; sem ela, GPS em campo (o cadastro de domicílio só recebe posição do GPS do aparelho). */
  geoPrecision?: PrecisaoGeo | null;
  /** Precisão da leitura do GPS em metros (95% de confiança): acima de 50 m a leitura não é gravada. */
  geoAccuracyM?: number | null;
  propertyType?: string | null;
  dwellingType?: string | null;
  tenure?: string | null;
  wallMaterial?: string | null;
  waterSupply?: string | null;
  waterTreatment?: string | null;
  sewage?: string | null;
  garbage?: string | null;
  electricity?: boolean | null;
  rooms?: number | null;
  animals?: string | null;
  microArea?: string | null;
  unitId?: string | null;
  teamId?: string | null;
  notes?: string | null;
}

export interface FamilyInput {
  responsibleId?: string | null;
  recordNumber?: string | null;
  incomeBracket?: string | null;
}

const familyInclude = {
  responsible: true,
  members: { where: { mergedIntoId: null }, orderBy: { birthDate: 'asc' as const } },
};
const householdInclude = { families: { where: { active: true }, include: familyInclude }, unit: { select: { id: true, name: true } }, team: { select: { id: true, ine: true, name: true } } };

/** Posições que são do imóvel (lidas ou marcadas), e não derivadas do endereço. */
const POSICAO_DE_CAMPO: PrecisaoGeo[] = ['GPS_CAMPO', 'MAPA'];

interface AtualGeo {
  latitude: number | null;
  longitude: number | null;
  geoPrecision: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  cep: string | null;
  ibgeCode: string | null;
}

const CAMPOS_ENDERECO = ['street', 'number', 'complement', 'district', 'cep', 'ibgeCode'] as const;

/** Algum campo do endereço enviado difere do gravado. */
function enderecoAlterado(novo: { street?: string | null; number?: string | null; complement?: string | null; district?: string | null; cep?: string | null; ibgeCode?: string | null }, atual: AtualGeo) {
  // O IBGE com 6 ou 7 dígitos é o mesmo município.
  const igual = (k: (typeof CAMPOS_ENDERECO)[number], a: string | null, b: string | null) => (k === 'ibgeCode' ? (a ?? '').slice(0, 6) === (b ?? '').slice(0, 6) : a === b);
  return CAMPOS_ENDERECO.some((k) => novo[k] !== undefined && !igual(k, novo[k] ?? null, atual[k] ?? null));
}

/** Domicílios e famílias: um paciente pertence a uma família, que vive num domicílio (base do cadastro domiciliar do e-SUS). */
@Injectable()
export class HouseholdsService {
  private readonly logger = new Logger('Domicilios');

  constructor(
    private readonly audit: AuditService,
    private readonly localizador: LocalizadorService,
    private readonly territorio: TerritorioService,
  ) {}

  async search(ctx: RequestContext, q: string) {
    const term = q.trim();
    const digits = onlyDigits(term);
    const rows = await ctx.db.household.findMany({
      where: {
        active: true,
        ...(digits.length === 8 ? { cep: digits } : term ? { OR: [{ street: { contains: term, mode: 'insensitive' } }, { district: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      include: householdInclude,
      orderBy: [{ street: 'asc' }, { number: 'asc' }],
      take: 30,
    });
    return rows.map((h) => this.view(h));
  }

  async get(ctx: RequestContext, id: string) {
    const h = await ctx.db.household.findUnique({ where: { id }, include: householdInclude });
    if (!h) throw notFound('Domicílio');
    return this.view(h);
  }

  /**
   * `posicionados`: quem grava em lote (a sincronização do ACS) junta aqui os imóveis que ganharam posição (ou
   * moradores) e avisa o território no fim; sem ele, o aviso sai logo depois do commit.
   */
  async create(ctx: RequestContext, input: HouseholdInput & { family?: FamilyInput | null }, posicionados?: string[]) {
    const geo = this.geo(input, null);
    const id = await ctx.db.$transaction(async (tx) => {
      const h = await tx.household.create({ data: { ...this.data(input), ...geo, unitId: input.unitId ?? ctx.session.unitId ?? null } });
      if (input.family) await this.newFamily(ctx, tx, h.id, input.family);
      // Território (PLT-3): com posição, o imóvel é ligado ao quarteirão que a contém (na mesma transação: o reenvio
      // da sincronização do ACS não pode achar o domicílio gravado pela metade).
      if (input.latitude != null && input.longitude != null) await this.localizador.vincularImovel(tx, h.id);
      await this.audit.record(ctx, tx, { action: 'domicilio.cadastrar', entityType: 'Household', entityId: h.id, payload: input });
      return h.id;
    });
    // Posição nova, ou o responsável da família nova que passou a morar aqui.
    if ('geoPrecision' in geo || input.family?.responsibleId) await this.avisarPosicao(ctx, id, posicionados);
    return this.view(await ctx.db.household.findUniqueOrThrow({ where: { id }, include: householdInclude }));
  }

  async update(ctx: RequestContext, id: string, input: HouseholdInput, posicionados?: string[]) {
    const h = await ctx.db.household.findUnique({ where: { id } });
    if (!h) throw notFound('Domicílio');
    // ACS fora da sua equipe e microárea: o cadastro é atualizado, mas a posição não (mesma regra da marcação no mapa).
    if ((input.latitude !== undefined || input.longitude !== undefined) && !(await this.localizador.noEscopoDeCampo(ctx, id)))
      input = { ...input, latitude: undefined, longitude: undefined, geoAccuracyM: undefined, geoPrecision: undefined };
    const geo = this.geo(input, h, await this.quarteiraoDoAceFica(ctx, input, h));
    await ctx.db.$transaction(async (tx) => {
      await tx.household.update({ where: { id }, data: { ...this.data(input), ...geo } });
      if ('geoPrecision' in geo) await this.localizador.vincularImovel(tx, id);
      await this.audit.record(ctx, tx, { action: 'domicilio.atualizar', entityType: 'Household', entityId: id, payload: input });
    });
    if ('geoPrecision' in geo) await this.avisarPosicao(ctx, id, posicionados);
    return this.view(await ctx.db.household.findUniqueOrThrow({ where: { id }, include: householdInclude }));
  }

  /**
   * Depois do commit: o imóvel ganhou (ou perdeu) posição, ou alguém entrou na família dele ou saiu dela. O gancho de
   * posição do território refaz na hora o retrato dos casos ativos dos moradores (e dos que guardam o imóvel) na ordem de
   * bloqueio. Em lote (`posicionados`), só junta o imóvel; quem grava o lote avisa uma vez, no fim.
   */
  private async avisarPosicao(ctx: RequestContext, id: string, posicionados?: string[]) {
    if (posicionados) posicionados.push(id);
    else await this.imoveisPosicionados(ctx, [id]);
  }

  /**
   * Imóveis que ganharam posição nova (ou a perderam) ou mudaram de moradores, depois do commit: o território avisa os
   * ouvintes, e a ordem de bloqueio refaz o retrato dos casos dos moradores. Nunca lança: a falha não desfaz o cadastro
   * (a varredura recupera).
   */
  async imoveisPosicionados(ctx: RequestContext, ids: string[]) {
    try {
      await this.territorio.imoveisPosicionados(ctx, ids);
    } catch (err) {
      this.logger.error(`Aviso da posição de ${ids.length} imóvel(is): ${(err as Error).message}`);
    }
  }

  /** O imóvel está na área do ACS (equipe e microárea); verdadeiro para os demais papéis. */
  noEscopoDeCampo(ctx: RequestContext, id: string) {
    return this.localizador.noEscopoDeCampo(ctx, id);
  }

  /**
   * A posição sai e levaria o quarteirão junto, e o imóvel foi criado pelo ACE em campo: o quarteirão escolhido lá fica,
   * só a posição sai. Vale para o cadastro que tira a posição (latitude ou longitude nula) e para a correção do endereço
   * que tira a posição que veio do endereço (endereço ou face de quadra). A origem do imóvel só é consultada nesses casos.
   */
  private async quarteiraoDoAceFica(ctx: RequestContext, input: HouseholdInput, h: AtualGeo & { id: string; blockId: string | null; geoSource: string | null }) {
    if (!h.blockId || h.latitude == null) return false;
    const precisao = h.geoPrecision as PrecisaoGeo | null;
    // Como em `geo`: com só uma das coordenadas no corpo, a outra continua a atual.
    const lat = input.latitude !== undefined ? input.latitude : h.latitude;
    const lng = input.longitude !== undefined ? input.longitude : h.longitude;
    const tiraPosicao = (input.latitude !== undefined || input.longitude !== undefined) && (lat == null || lng == null);
    const tiraPosicaoDoEndereco = !!precisao && ENDERECO_LIGA_QUARTEIRAO.includes(precisao) && enderecoAlterado(this.data(input), h);
    if (!tiraPosicao && !tiraPosicaoDoEndereco) return false;
    return this.localizador.quarteiraoEscolhidoEmCampo(ctx.db, h);
  }

  /** Liga o imóvel ao quarteirão que contém a posição dele (ou desliga, se ficou sem posição ou fora da malha). */
  ligarAoQuarteirao(db: Parameters<LocalizadorService['vincularImovel']>[0], id: string) {
    return this.localizador.vincularImovel(db, id);
  }

  /** Quarteirão ativo a que a malha liga o ponto: o que o contém ou, na rua, o mais próximo até a tolerância. */
  quarteiraoDoPonto(db: Parameters<LocalizadorService['quarteiraoDoPonto']>[0], lat: number, lng: number) {
    return this.localizador.quarteiraoDoPonto(db, lat, lng);
  }

  /**
   * Precisão da posição quando ela muda: a enviada (o app do ACS manda o raio do GPS) ou GPS em campo. Sem posição,
   * a precisão e o quarteirão saem junto, mas nunca o quarteirão escolhido pelo ACE em campo (`quarteiraoDoAce`): só a
   * posição sai. Na correção do endereço, só sai o quarteirão que veio da posição do endereço.
   */
  private geo(input: HouseholdInput, atual: AtualGeo | null, quarteiraoDoAce = false) {
    const semPosicao = { latitude: null, longitude: null, geoPrecision: null, geoSource: null, geoAccuracyM: null, geoAt: null, blockId: null };
    const naoMuda = { latitude: undefined, longitude: undefined };
    // Endereço corrigido sem leitura nova: a posição que veio do endereço antigo (base do IBGE, centro de rua ou de
    // bairro) deixa de valer; GPS e marcação no mapa são do imóvel e ficam. O centro do quarteirão também fica: vem do
    // quarteirão que o imóvel já tem (o escolhido pelo ACE em campo), não do endereço. E o quarteirão só sai junto com a
    // posição que o ligou a ele (endereço ou face de quadra na base do IBGE); o escolhido em campo fica, também no imóvel
    // criado pelo ACE que o endereço da base do IBGE confirmou (a posição sai, o quarteirão não).
    const precisaoAtual = (atual?.geoPrecision ?? null) as PrecisaoGeo | null;
    const posicaoDoEndereco = !!atual && atual.latitude != null && !!precisaoAtual && !POSICAO_DE_CAMPO.includes(precisaoAtual) && precisaoAtual !== 'QUARTEIRAO';
    const semPosicaoDoEndereco = !quarteiraoDoAce && precisaoAtual && PRECISAO_LIGA_QUARTEIRAO.includes(precisaoAtual) ? semPosicao : { ...semPosicao, blockId: undefined };
    const enderecoMudou = !!atual && enderecoAlterado(this.data(input), atual);
    if (input.latitude === undefined && input.longitude === undefined) return posicaoDoEndereco && enderecoMudou ? semPosicaoDoEndereco : {};
    // Só uma das coordenadas no corpo: a outra continua a atual.
    const lat = input.latitude !== undefined ? input.latitude : (atual?.latitude ?? null);
    const lng = input.longitude !== undefined ? input.longitude : (atual?.longitude ?? null);
    // Posição tirada pelo cadastro: tirar a posição não é escolher outro quarteirão, e o escolhido pelo ACE em campo fica.
    if (lat == null || lng == null) return atual?.latitude == null ? {} : quarteiraoDoAce ? { ...semPosicao, blockId: undefined } : semPosicao;
    if (atual && atual.latitude === lat && atual.longitude === lng && input.geoPrecision === undefined) return posicaoDoEndereco && enderecoMudou ? semPosicaoDoEndereco : naoMuda;
    // Leitura do GPS acima de 50 m (rede ou ambiente fechado) não serve à posição do imóvel: não é gravada.
    if (input.geoAccuracyM != null && avaliarGps(input.geoAccuracyM) === 'NOVA_LEITURA') return posicaoDoEndereco && enderecoMudou ? semPosicaoDoEndereco : naoMuda;
    return { geoPrecision: input.geoPrecision ?? ('GPS_CAMPO' as const), geoSource: 'cadastro', geoAccuracyM: input.geoAccuracyM ?? null, geoAt: new Date() };
  }

  async createFamily(ctx: RequestContext, householdId: string, input: FamilyInput) {
    const h = await ctx.db.household.findUnique({ where: { id: householdId } });
    if (!h) throw notFound('Domicílio');
    const familia = await ctx.db.$transaction(async (tx) => {
      const f = await this.newFamily(ctx, tx, householdId, input);
      return this.familyView(await tx.family.findUniqueOrThrow({ where: { id: f.id }, include: familyInclude }));
    });
    // O responsável passou a morar neste domicílio: o caso dele na ordem de bloqueio é refeito na hora.
    if (input.responsibleId) await this.avisarPosicao(ctx, householdId);
    return familia;
  }

  async updateFamily(ctx: RequestContext, id: string, input: FamilyInput) {
    const f = await ctx.db.family.findUnique({ where: { id } });
    if (!f) throw notFound('Família');
    const familia = await ctx.db.$transaction(async (tx) => {
      await tx.family.update({ where: { id }, data: { recordNumber: input.recordNumber ?? undefined, incomeBracket: input.incomeBracket ?? undefined } });
      if (input.responsibleId) await this.setResponsible(tx, id, input.responsibleId);
      await this.audit.record(ctx, tx, { action: 'familia.atualizar', entityType: 'Family', entityId: id, payload: input });
      return this.familyView(await tx.family.findUniqueOrThrow({ where: { id }, include: familyInclude }));
    });
    // O responsável novo pode ter vindo de outra família (outro domicílio).
    if (input.responsibleId) await this.avisarPosicao(ctx, f.householdId);
    return familia;
  }

  /**
   * Inclui um paciente na família (ele sai de qualquer outra); parentesco "00" o torna responsável. Depois do commit, o
   * caso dele na ordem de bloqueio é refeito com o domicílio novo (em lote, `posicionados`, como em `create`).
   */
  async addMember(ctx: RequestContext, familyId: string, patientId: string, kinship: string, posicionados?: string[]) {
    const f = await ctx.db.family.findUnique({ where: { id: familyId } });
    if (!f) throw notFound('Família');
    const p = await ctx.db.patient.findUnique({ where: { id: patientId } });
    if (!p || p.mergedIntoId) throw notFound('Paciente');
    const familia = await ctx.db.$transaction(async (tx) => {
      await tx.patient.update({ where: { id: patientId }, data: { familyId, kinship } });
      if (kinship === '00') await this.setResponsible(tx, familyId, patientId);
      await this.audit.record(ctx, tx, { action: 'familia.incluir_membro', entityType: 'Family', entityId: familyId, payload: { patientId, kinship } });
      return this.familyView(await tx.family.findUniqueOrThrow({ where: { id: familyId }, include: familyInclude }));
    });
    // Já era da família (só o parentesco mudou): o domicílio é o mesmo.
    if (p.familyId !== familyId) await this.avisarPosicao(ctx, f.householdId, posicionados);
    return familia;
  }

  async removeMember(ctx: RequestContext, familyId: string, patientId: string) {
    const f = await ctx.db.family.findUnique({ where: { id: familyId } });
    if (!f) throw notFound('Família');
    const { familia, saiu } = await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.patient.updateMany({ where: { id: patientId, familyId }, data: { familyId: null, kinship: null } });
      if (f.responsibleId === patientId) await tx.family.update({ where: { id: familyId }, data: { responsibleId: null } });
      await this.audit.record(ctx, tx, { action: 'familia.remover_membro', entityType: 'Family', entityId: familyId, payload: { patientId } });
      return { familia: this.familyView(await tx.family.findUniqueOrThrow({ where: { id: familyId }, include: familyInclude })), saiu: count > 0 };
    });
    // A pessoa ficou sem domicílio: o caso dela, que guardava este imóvel, é refeito na hora.
    if (saiu) await this.avisarPosicao(ctx, f.householdId);
    return familia;
  }

  private async newFamily(ctx: RequestContext, tx: Parameters<AuditService['record']>[1], householdId: string, input: FamilyInput) {
    const f = await tx.family.create({ data: { householdId, recordNumber: input.recordNumber ?? null, incomeBracket: input.incomeBracket ?? null } });
    if (input.responsibleId) await this.setResponsible(tx, f.id, input.responsibleId);
    await this.audit.record(ctx, tx, { action: 'familia.cadastrar', entityType: 'Family', entityId: f.id, payload: input });
    return f;
  }

  private async setResponsible(tx: Parameters<AuditService['record']>[1], familyId: string, patientId: string) {
    const p = await tx.patient.findUnique({ where: { id: patientId } });
    if (!p || p.mergedIntoId) throw notFound('Paciente responsável');
    const family = await tx.family.findUniqueOrThrow({ where: { id: familyId } });
    // Quem era responsável continua na família como "outro parente" até ser reclassificado.
    if (family.responsibleId && family.responsibleId !== patientId) {
      await tx.patient.updateMany({ where: { id: family.responsibleId, familyId, kinship: '00' }, data: { kinship: '09' } });
    }
    await tx.patient.update({ where: { id: patientId }, data: { familyId, kinship: '00' } });
    await tx.family.update({ where: { id: familyId }, data: { responsibleId: patientId } });
  }

  private data(input: HouseholdInput) {
    const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    return {
      cep: input.cep === undefined ? undefined : input.cep ? onlyDigits(input.cep) : null,
      street: clean(input.street),
      number: clean(input.number),
      complement: clean(input.complement),
      district: clean(input.district),
      city: clean(input.city),
      uf: input.uf === undefined ? undefined : input.uf?.toUpperCase() || null,
      ibgeCode: input.ibgeCode === undefined ? undefined : input.ibgeCode ? onlyDigits(input.ibgeCode) : null,
      latitude: input.latitude,
      longitude: input.longitude,
      propertyType: clean(input.propertyType),
      dwellingType: clean(input.dwellingType),
      tenure: clean(input.tenure),
      wallMaterial: clean(input.wallMaterial),
      waterSupply: clean(input.waterSupply),
      waterTreatment: clean(input.waterTreatment),
      sewage: clean(input.sewage),
      garbage: clean(input.garbage),
      electricity: input.electricity,
      rooms: input.rooms,
      animals: clean(input.animals),
      microArea: clean(input.microArea),
      unitId: input.unitId,
      teamId: input.teamId,
      notes: clean(input.notes),
    };
  }

  private view(h: {
    id: string;
    cep: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    uf: string | null;
    ibgeCode: string | null;
    latitude: number | null;
    longitude: number | null;
    propertyType: string | null;
    dwellingType: string | null;
    tenure: string | null;
    wallMaterial: string | null;
    waterSupply: string | null;
    waterTreatment: string | null;
    sewage: string | null;
    garbage: string | null;
    electricity: boolean | null;
    rooms: number | null;
    animals: string | null;
    microArea: string | null;
    notes: string | null;
    active: boolean;
    unit: { id: string; name: string } | null;
    team: { id: string; ine: string; name: string } | null;
    families: Parameters<HouseholdsService['familyView']>[0][];
  }) {
    const { families, unit, team, ...rest } = h;
    return {
      ...rest,
      addressLine: [h.street, h.number, h.complement, h.district].filter(Boolean).join(', ') || null,
      unit,
      team,
      families: families.map((f) => this.familyView(f)),
    };
  }

  private familyView(f: {
    id: string;
    householdId: string;
    responsibleId: string | null;
    recordNumber: string | null;
    incomeBracket: string | null;
    active: boolean;
    responsible: Parameters<typeof patientSummary>[0] | null;
    members: (Parameters<typeof patientSummary>[0] & { kinship: string | null })[];
  }) {
    return {
      id: f.id,
      householdId: f.householdId,
      recordNumber: f.recordNumber,
      incomeBracket: f.incomeBracket,
      responsible: f.responsible ? patientSummary(f.responsible) : null,
      members: f.members.map((m) => ({ ...patientSummary(m), kinship: m.kinship })),
    };
  }
}

export function assertKinship(code: string) {
  if (!/^\d{2}$/.test(code)) throw new DomainError('PARENTESCO_INVALIDO', 'Parentesco inválido', HttpStatus.UNPROCESSABLE_ENTITY);
}
