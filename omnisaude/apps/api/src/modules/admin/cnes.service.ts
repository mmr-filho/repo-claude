import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { appendAudit, type TenantPrisma } from '@omnisaude/database';
import {
  CNES_UNIT_TYPES,
  ibge6,
  ibge7,
  isRole,
  isValidCns,
  isValidCpf,
  onlyDigits,
  ROLE_LABELS,
  roleFromCbo,
  roleHasPermission,
  TEAM_TYPES,
  teamTypeLabel,
  unitTypeFromCnes,
  UNIT_TYPES,
  cboLabel,
  type Role,
  type UnitType,
} from '@omnisaude/shared';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { AdminService } from './admin.service';
import { tableFromCsv } from './csv';

type Tx = TenantPrisma.TransactionClient;

export interface CnesEstablishment {
  cnes: string;
  name: string;
  rawName: string;
  legalName: string | null;
  typeCode: string;
  typeLabel: string;
  suggestedType: UnitType | null;
  isPublic: boolean;
  legalNature: string | null;
  management: string | null;
  susAmbulatory: boolean | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  openingHours: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  updatedAt: string | null;
}

export interface EstablishmentRow extends CnesEstablishment {
  existing: { id: string; name: string; type: string; active: boolean } | null;
  action: 'novo' | 'atualizar' | 'igual' | 'inativo';
  changes: string[];
  preselected: boolean;
}

export interface ProfessionalRow {
  line: number;
  name: string;
  cpf: string | null;
  cns: string | null;
  cbo: string;
  cboLabel: string | null;
  cnes: string | null;
  unitId: string | null;
  unitName: string | null;
  ine: string | null;
  teamFound: boolean;
  role: Role | null;
  council: string | null;
  email: string | null;
  phone: string | null;
  /** acesso: cria usuário; existente: só a lotação; pre_cadastro: sem CPF; erro: não importa. */
  status: 'acesso' | 'existente' | 'pre_cadastro' | 'erro';
  errors: string[];
}

export interface TeamRow {
  line: number;
  ine: string;
  typeCode: string | null;
  typeLabel: string | null;
  name: string;
  cnes: string | null;
  unitId: string | null;
  unitName: string | null;
  area: string | null;
  status: 'nova' | 'atualizar' | 'erro';
  errors: string[];
}

const PROF_COLUMNS = {
  cpf: ['cpf'],
  cns: ['cns', 'cartao_sus', 'cartao_nacional_de_saude', 'co_cns', 'n_cns'],
  name: ['nome', 'nome_completo', 'profissional', 'no_profissional', 'nome_do_profissional'],
  cbo: ['cbo', 'co_cbo', 'ocupacao', 'codigo_cbo'],
  cnes: ['cnes', 'cnes_unidade', 'cnes_da_unidade', 'unidade', 'co_unidade', 'estabelecimento'],
  ine: ['ine', 'co_ine', 'equipe', 'co_equipe', 'codigo_ine'],
  role: ['papel', 'perfil', 'role'],
  council: ['conselho', 'registro', 'registro_conselho', 'conselho_registro'],
  email: ['email', 'e_mail'],
  phone: ['telefone', 'celular', 'fone'],
};
const TEAM_COLUMNS = {
  ine: ['ine', 'co_equipe', 'codigo_ine', 'co_ine'],
  type: ['tipo', 'tipo_equipe', 'tp_equipe', 'tipo_de_equipe'],
  name: ['nome', 'nome_equipe', 'referencia', 'no_referencia', 'nome_da_equipe'],
  cnes: ['cnes', 'cnes_unidade', 'cnes_da_unidade', 'unidade', 'co_unidade'],
  area: ['area', 'co_area', 'segmento', 'segmento_territorial'],
};

const ACRONYMS = new Set(['UBS', 'USF', 'UPA', 'CEO', 'CAPS', 'SAMU', 'USA', 'USB', 'UTI', 'PSF', 'NASF', 'CER', 'CCZ', 'CAF', 'GAF', 'CTA', 'SAE', 'ESF', 'AD', 'SUS', 'CEREST', 'LACEN', 'I', 'II', 'III', 'IV', 'UFT', 'UMS', 'CRAS', 'CREAS']);
const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'na', 'no', 'ao', 'aos', 'à', 'às']);
// Palavras do vocabulário da saúde devolvidas com acento (o CNES grava tudo em maiúsculas sem acento).
const ACCENTS: Record<string, string> = {
  dr: 'Dr.',
  dra: 'Dra.',
  saude: 'Saúde',
  basica: 'Básica',
  basico: 'Básico',
  municipio: 'Município',
  municipal: 'Municipal',
  policlinica: 'Policlínica',
  farmacia: 'Farmácia',
  clinica: 'Clínica',
  vigilancia: 'Vigilância',
  epidemiologica: 'Epidemiológica',
  sanitaria: 'Sanitária',
  odontologicas: 'Odontológicas',
  odontologico: 'Odontológico',
  atencao: 'Atenção',
  regulacao: 'Regulação',
  assistencia: 'Assistência',
  farmaceutica: 'Farmacêutica',
  farmaceutico: 'Farmacêutico',
  laboratorio: 'Laboratório',
  familia: 'Família',
  referencia: 'Referência',
  publica: 'Pública',
  medico: 'Médico',
  medica: 'Médica',
  sao: 'São',
  jose: 'José',
  joao: 'João',
  antonio: 'Antônio',
  especializado: 'Especializado',
  psicossocial: 'Psicossocial',
  marcia: 'Márcia',
  lucia: 'Lúcia',
  luis: 'Luís',
  fabio: 'Fábio',
  julio: 'Júlio',
  ines: 'Inês',
  movel: 'Móvel',
  basicas: 'Básicas',
  urgencia: 'Urgência',
  emergencia: 'Emergência',
  pediatrico: 'Pediátrico',
  especialidades: 'Especialidades',
  nucleo: 'Núcleo',
  indigena: 'Indígena',
  acacias: 'Acácias',
  avancado: 'Avançado',
  servico: 'Serviço',
  comunitaria: 'Comunitária',
  gerencia: 'Gerência',
  ambulatorio: 'Ambulatório',
  centro: 'Centro',
  especializada: 'Especializada',
  ortopedico: 'Ortopédico',
  cirurgico: 'Cirúrgico',
  oncologico: 'Oncológico',
  cardiologico: 'Cardiológico',
  materno: 'Materno',
  infantil: 'Infantil',
  psiquiatrico: 'Psiquiátrico',
  terapeutica: 'Terapêutica',
  diagnostico: 'Diagnóstico',
  imunizacao: 'Imunização',
  reabilitacao: 'Reabilitação',
  nutricao: 'Nutrição',
  alimentacao: 'Alimentação',
  prevencao: 'Prevenção',
  promocao: 'Promoção',
  notificacao: 'Notificação',
  distribuicao: 'Distribuição',
  orgaos: 'Órgãos',
  publico: 'Público',
  zoonoses: 'Zoonoses',
  zoonozes: 'Zoonoses',
};

/** "UNIDADE BASICA DE SAUDE NEY LUZ E SILVA" → "Unidade Básica de Saúde Ney Luz e Silva". */
export function readableName(upper: string): string {
  return upper
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      const u = w.toUpperCase();
      if (ACRONYMS.has(u)) return u;
      if (ACCENTS[w]) return ACCENTS[w];
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function openingHoursFromTurno(desc: unknown): string | null {
  if (typeof desc !== 'string' || !desc.trim()) return null;
  const d = desc.toUpperCase();
  if (d.includes('24 HORAS')) return '24 horas';
  const m = d.includes('MANHA');
  const t = d.includes('TARDE');
  const n = d.includes('NOITE');
  if (m && t && n) return 'Manhã, tarde e noite';
  if (m && t) return 'Manhã e tarde';
  if (m) return 'Manhã';
  if (t) return 'Tarde';
  if (n) return 'Noite';
  return readableName(desc);
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);

/**
 * Importação do CNES: estabelecimentos pela API de dados abertos do Ministério da Saúde (prévia com
 * conciliação e aplicação seletiva) e profissionais/equipes por planilha. O que entra sem CPF fica como
 * pré-cadastro para a gestão completar.
 */
@Injectable()
export class CnesService {
  private readonly logger = new Logger('CNES');
  private readonly baseUrl: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly admin: AdminService,
  ) {
    this.baseUrl = config.CNES_API_URL.replace(/\/$/, '');
  }

  // ── Estabelecimentos (API do DATASUS) ──

  async previewEstablishments(ctx: RequestContext, ibgeCode: string) {
    const ibge = ibge6(ibgeCode);
    if (!/^\d{6}$/.test(ibge)) throw new DomainError('IBGE_INVALIDO', 'Código IBGE do município deve ter 6 ou 7 dígitos', HttpStatus.UNPROCESSABLE_ENTITY);
    const list = await this.fetchEstablishments(ibge);
    if (list.length === 0) throw new DomainError('CNES_VAZIO', 'O CNES não devolveu estabelecimentos para este município', HttpStatus.NOT_FOUND);
    const units = await ctx.db.unit.findMany();
    const byCnes = new Map(units.map((u) => [u.cnes, u]));
    const rows: EstablishmentRow[] = list.map((e) => {
      const ex = byCnes.get(e.cnes);
      const changes: string[] = [];
      let action: EstablishmentRow['action'];
      if (!e.active) action = 'inativo';
      else if (!ex) action = 'novo';
      else {
        if (ex.name !== e.name) changes.push(`nome no CNES: ${e.name}`);
        if (!ex.phone && e.phone) changes.push('telefone');
        if (!ex.email && e.email) changes.push('e-mail');
        if (!ex.address && e.address) changes.push('endereço');
        if (!ex.openingHours && e.openingHours) changes.push('horário');
        if (ex.latitude == null && e.latitude != null) changes.push('coordenadas');
        if (ex.cnesTypeCode !== e.typeCode) changes.push('dados do CNES');
        action = changes.length ? 'atualizar' : 'igual';
      }
      return {
        ...e,
        existing: ex ? { id: ex.id, name: ex.name, type: ex.type, active: ex.active } : null,
        action,
        changes,
        preselected: e.active && e.isPublic && action !== 'igual',
      };
    });
    rows.sort((a, b) => Number(b.isPublic) - Number(a.isPublic) || a.typeCode.localeCompare(b.typeCode) || a.name.localeCompare(b.name, 'pt-BR'));
    const missing = units.filter((u) => u.active && !byCnesIn(list, u.cnes)).map((u) => ({ id: u.id, cnes: u.cnes, name: u.name }));
    const summary = {
      total: rows.length,
      publicos: rows.filter((r) => r.isPublic && r.active).length,
      privadosSus: rows.filter((r) => !r.isPublic && r.active && r.susAmbulatory).length,
      novos: rows.filter((r) => r.action === 'novo').length,
      atualizar: rows.filter((r) => r.action === 'atualizar').length,
      iguais: rows.filter((r) => r.action === 'igual').length,
      inativos: rows.filter((r) => r.action === 'inativo').length,
      foraDoCnes: missing.length,
    };
    const imp = await ctx.db.cnesImport.create({
      data: { kind: 'ESTABELECIMENTOS', ibgeCode: ibge, source: this.baseUrl, summary, payload: { rows, missing } as object, actorId: ctx.session.userId },
    });
    return { importId: imp.id, ibgeCode: ibge, fetchedAt: imp.createdAt, summary, rows, missing };
  }

  async applyEstablishments(ctx: RequestContext, importId: string, input: { cnes: string[]; types?: Record<string, UnitType>; updateNames?: boolean }) {
    const imp = await this.openImport(ctx, importId, 'ESTABELECIMENTOS');
    const { rows } = imp.payload as unknown as { rows: EstablishmentRow[] };
    const wanted = new Set(input.cnes.map((c) => c.padStart(7, '0')));
    const selected = rows.filter((r) => wanted.has(r.cnes) && r.active);
    if (selected.length === 0) throw new DomainError('NADA_SELECIONADO', 'Selecione ao menos um estabelecimento ativo', HttpStatus.UNPROCESSABLE_ENTITY);
    const typeOf = (r: EstablishmentRow) => {
      const t = input.types?.[r.cnes] ?? r.suggestedType;
      return t && (UNIT_TYPES as readonly string[]).includes(t) ? (t as UnitType) : null;
    };
    const needType = selected.filter((r) => !r.existing && !typeOf(r));
    if (needType.length) {
      throw new DomainError('TIPO_NECESSARIO', `Informe o tipo no OmniSaúde para: ${needType.map((r) => `${r.cnes} ${r.name}`).join('; ')}`, HttpStatus.UNPROCESSABLE_ENTITY, { cnes: needType.map((r) => r.cnes) });
    }
    const ibgeCode = ibge7(imp.ibgeCode ?? '');
    const result = { created: [] as string[], updated: [] as string[], unchanged: [] as string[] };
    await ctx.db.$transaction(async (tx) => {
      for (const r of selected) {
        const cnesData = {
          latitude: r.latitude,
          longitude: r.longitude,
          cnesTypeCode: r.typeCode,
          legalNature: r.legalNature,
          management: r.management,
          susAmbulatory: r.susAmbulatory,
          cnesUpdatedAt: r.updatedAt ? new Date(r.updatedAt) : null,
        };
        if (r.existing) {
          const ex = await tx.unit.findUniqueOrThrow({ where: { id: r.existing.id } });
          await tx.unit.update({
            where: { id: ex.id },
            data: {
              ...cnesData,
              ...(input.updateNames && ex.name !== r.name ? { name: r.name } : {}),
              phone: ex.phone ?? r.phone,
              email: ex.email ?? r.email,
              address: ex.address ?? r.address,
              openingHours: ex.openingHours ?? r.openingHours,
            },
          });
          (r.changes.length ? result.updated : result.unchanged).push(r.name);
        } else {
          await tx.unit.create({
            data: { cnes: r.cnes, name: r.name, type: typeOf(r)!, ibgeCode, address: r.address, phone: r.phone, email: r.email, openingHours: r.openingHours, source: 'CNES', ...cnesData },
          });
          result.created.push(r.name);
        }
      }
      await this.close(tx, ctx, imp.id, imp.summary, { criadas: result.created.length, atualizadas: result.updated.length }, 'cnes.estabelecimentos', { ibge: imp.ibgeCode, ...result });
    });
    return result;
  }

  /** A API devolve no máximo 20 por página: busca várias páginas em paralelo até a primeira página incompleta. */
  private async fetchEstablishments(ibge: string): Promise<CnesEstablishment[]> {
    const PAGE = 20;
    const PARALLEL = 8;
    const out: CnesEstablishment[] = [];
    const seen = new Set<string>();
    for (let batch = 0; batch < 400; batch++) {
      const offsets = Array.from({ length: PARALLEL }, (_, i) => (batch * PARALLEL + i) * PAGE);
      const pages = await Promise.all(offsets.map((offset) => this.fetchPage(ibge, offset, PAGE)));
      let done = false;
      for (const page of pages) {
        for (const raw of page) {
          const e = this.mapEstablishment(raw);
          if (!seen.has(e.cnes)) {
            seen.add(e.cnes);
            out.push(e);
          }
        }
        if (page.length < PAGE) done = true;
      }
      if (done) break;
    }
    return out;
  }

  private async fetchPage(ibge: string, offset: number, limit: number): Promise<Record<string, unknown>[]> {
    const url = `${this.baseUrl}/cnes/estabelecimentos?codigo_municipio=${ibge}&limit=${limit}&offset=${offset}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    } catch (err) {
      this.logger.warn(`Falha ao consultar ${url}: ${(err as Error).message}`);
      throw new DomainError('CNES_INDISPONIVEL', 'Não foi possível consultar o CNES agora (DATASUS fora do ar ou sem rede). Tente de novo em instantes.', HttpStatus.BAD_GATEWAY);
    }
    if (!res.ok) throw new DomainError('CNES_INDISPONIVEL', `O CNES respondeu HTTP ${res.status}`, HttpStatus.BAD_GATEWAY);
    const data = (await res.json()) as { estabelecimentos?: Record<string, unknown>[] };
    return data.estabelecimentos ?? [];
  }

  private mapEstablishment(raw: Record<string, unknown>): CnesEstablishment {
    const cnes = String(raw.codigo_cnes ?? '').replace(/\D/g, '').padStart(7, '0');
    const typeCode = String(raw.codigo_tipo_unidade ?? '').replace(/\D/g, '').padStart(2, '0');
    const legalNature = str(raw.descricao_natureza_juridica_estabelecimento ?? raw.codigo_natureza_juridica);
    const management = str(raw.tipo_gestao)?.charAt(0).toUpperCase() ?? null;
    const rawName = str(raw.nome_fantasia) ?? str(raw.nome_razao_social) ?? `Estabelecimento ${cnes}`;
    const cep = str(raw.codigo_cep_estabelecimento)?.replace(/\D/g, '');
    const street = [str(raw.endereco_estabelecimento), str(raw.numero_estabelecimento)].filter(Boolean).join(', ');
    const district = str(raw.bairro_estabelecimento);
    const address = [street ? readableName(street) : null, district ? readableName(district) : null].filter(Boolean).join(' - ') + (cep && cep.length === 8 ? ` - CEP ${cep.slice(0, 5)}-${cep.slice(5)}` : '');
    const sus = str(raw.estabelecimento_faz_atendimento_ambulatorial_sus);
    const lat = Number(raw.latitude_estabelecimento_decimo_grau);
    const lon = Number(raw.longitude_estabelecimento_decimo_grau);
    return {
      cnes,
      name: readableName(rawName),
      rawName,
      legalName: str(raw.nome_razao_social),
      typeCode,
      typeLabel: CNES_UNIT_TYPES[typeCode] ?? `Tipo ${typeCode}`,
      suggestedType: unitTypeFromCnes(typeCode),
      isPublic: !!legalNature && legalNature.startsWith('1'),
      legalNature: legalNature?.slice(0, 4) ?? null,
      management: management && /^[A-Z]$/.test(management) ? management : null,
      susAmbulatory: sus ? sus.toUpperCase().startsWith('S') : null,
      address: address || null,
      phone: str(raw.numero_telefone_estabelecimento),
      email: str(raw.endereco_email_estabelecimento)?.toLowerCase() ?? null,
      openingHours: openingHoursFromTurno(raw.descricao_turno_atendimento),
      latitude: Number.isFinite(lat) && lat !== 0 ? lat : null,
      longitude: Number.isFinite(lon) && lon !== 0 ? lon : null,
      active: !str(raw.codigo_motivo_desabilitacao_estabelecimento),
      updatedAt: str(raw.data_atualizacao),
    };
  }

  // ── Profissionais (planilha) ──

  async previewProfessionals(ctx: RequestContext, csv: string) {
    const table = tableFromCsv(csv, PROF_COLUMNS);
    if (!table.found.includes('name') || !table.found.includes('cbo') || !table.found.includes('cnes')) {
      throw new DomainError('PLANILHA_INVALIDA', 'A planilha precisa das colunas nome, cbo e cnes (baixe o modelo)', HttpStatus.UNPROCESSABLE_ENTITY, { headers: table.headers });
    }
    const units = await ctx.db.unit.findMany({ where: { active: true }, select: { id: true, cnes: true, name: true } });
    const unitByCnes = new Map(units.map((u) => [u.cnes, u]));
    const ines = [...new Set(table.rows.map((r) => onlyDigits(r.values.ine ?? '')).filter((v) => v.length === 10))];
    const teams = await ctx.db.team.findMany({ where: { ine: { in: ines } }, select: { ine: true } });
    const teamIne = new Set(teams.map((t) => t.ine));
    const cpfs = [...new Set(table.rows.map((r) => onlyDigits(r.values.cpf ?? '')).filter((v) => v.length === 11))];
    const existingUsers = await ctx.db.user.findMany({ where: { cpf: { in: cpfs } }, select: { cpf: true } });
    const existingCpf = new Set(existingUsers.map((u) => u.cpf));

    const rows: ProfessionalRow[] = table.rows.map(({ line, values }) => {
      const errors: string[] = [];
      const name = (values.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 5) errors.push('nome incompleto');
      const cpfDigits = onlyDigits(values.cpf ?? '');
      const cpf = cpfDigits ? cpfDigits : null;
      if (cpf && !isValidCpf(cpf)) errors.push('CPF inválido');
      const cnsDigits = onlyDigits(values.cns ?? '');
      const cns = cnsDigits ? cnsDigits : null;
      if (cns && !isValidCns(cns)) errors.push('CNS inválido');
      const cbo = onlyDigits(values.cbo ?? '');
      if (!/^\d{6}$/.test(cbo)) errors.push('CBO deve ter 6 dígitos');
      const cnesDigits = onlyDigits(values.cnes ?? '');
      const cnes = cnesDigits ? cnesDigits.padStart(7, '0') : null;
      const unit = cnes ? unitByCnes.get(cnes) : undefined;
      if (!unit) errors.push(cnes ? `unidade com CNES ${cnes} não cadastrada (importe os estabelecimentos antes)` : 'CNES da unidade em branco');
      const ineDigits = onlyDigits(values.ine ?? '');
      const ine = ineDigits ? ineDigits.padStart(10, '0') : null;
      if (ine && ine.length !== 10) errors.push('INE deve ter 10 dígitos');
      const role = parseRole(values.role) ?? (cbo.length === 6 ? roleFromCbo(cbo) : null);
      const status: ProfessionalRow['status'] = errors.length ? 'erro' : cpf ? (existingCpf.has(cpf) ? 'existente' : 'acesso') : 'pre_cadastro';
      return {
        line,
        name,
        cpf,
        cns,
        cbo,
        cboLabel: cboLabel(cbo) ?? null,
        cnes,
        unitId: unit?.id ?? null,
        unitName: unit?.name ?? null,
        ine,
        teamFound: !!ine && teamIne.has(ine),
        role,
        council: str(values.council),
        email: str(values.email)?.toLowerCase() ?? null,
        phone: str(values.phone) ? onlyDigits(values.phone!) : null,
        status,
        errors,
      };
    });
    const summary = {
      linhas: rows.length,
      acessos: rows.filter((r) => r.status === 'acesso').length,
      existentes: rows.filter((r) => r.status === 'existente').length,
      preCadastro: rows.filter((r) => r.status === 'pre_cadastro').length,
      erros: rows.filter((r) => r.status === 'erro').length,
      semEquipe: rows.filter((r) => r.ine && !r.teamFound).length,
    };
    const imp = await ctx.db.cnesImport.create({ data: { kind: 'PROFISSIONAIS', source: 'planilha', summary, payload: { rows } as object, actorId: ctx.session.userId } });
    return { importId: imp.id, summary, rows, columns: table.found };
  }

  async applyProfessionals(ctx: RequestContext, importId: string, input: { createAccess: boolean }) {
    const imp = await this.openImport(ctx, importId, 'PROFISSIONAIS');
    const { rows } = imp.payload as unknown as { rows: ProfessionalRow[] };
    const valid = rows.filter((r) => r.status !== 'erro' && r.unitId && r.role);
    if (valid.length === 0) throw new DomainError('NADA_A_IMPORTAR', 'Nenhuma linha válida na planilha', HttpStatus.UNPROCESSABLE_ENTITY);
    const access: { name: string; cpf: string; provisionalPassword: string }[] = [];
    const linked: string[] = [];
    const staged: string[] = [];
    const warnings: string[] = [];

    // Um profissional pode ter várias linhas (uma por lotação): agrupa por CPF, ou por nome quando não há CPF.
    const groups = new Map<string, ProfessionalRow[]>();
    for (const r of valid) {
      const key = r.cpf ? `cpf:${r.cpf}` : `nome:${r.name.toLowerCase()}|${r.cnes}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }

    for (const group of groups.values()) {
      const first = group[0]!;
      const assignments = group.map((r) => ({ unitId: r.unitId!, role: r.role!, cbo: r.cbo, council: r.council }));
      if (first.cpf) {
        const existing = await ctx.db.user.findUnique({ where: { cpf: first.cpf } });
        let userId: string;
        if (existing) {
          for (const a of assignments) await this.admin.addAssignment(ctx, existing.id, a);
          userId = existing.id;
          linked.push(first.name);
        } else if (input.createAccess) {
          const created = await this.admin.createUser(ctx, { cpf: first.cpf, cns: first.cns, name: first.name, email: first.email, phone: first.phone, assignments });
          userId = created.user.id;
          access.push({ name: first.name, cpf: first.cpf, provisionalPassword: created.provisionalPassword });
        } else {
          await this.stage(ctx, imp.id, group);
          staged.push(first.name);
          continue;
        }
        for (const r of group) if (r.ine) await this.joinTeam(ctx.db, r, { userId }, warnings);
      } else {
        await this.stage(ctx, imp.id, group);
        staged.push(first.name);
      }
    }
    await ctx.db.$transaction((tx) =>
      this.close(tx, ctx, imp.id, imp.summary, { acessos: access.length, vinculados: linked.length, preCadastros: staged.length }, 'cnes.profissionais', { acessos: access.map((a) => a.cpf), vinculados: linked, preCadastros: staged }),
    );
    return { access, linked, staged, warnings, errors: rows.filter((r) => r.status === 'erro').map((r) => `linha ${r.line}: ${r.errors.join(', ')}`) };
  }

  private async stage(ctx: RequestContext, importId: string, group: ProfessionalRow[]) {
    for (const r of group) {
      const row = await ctx.db.cnesProfessional.create({
        data: { name: r.name, cpf: r.cpf, cns: r.cns, cbo: r.cbo, council: r.council, unitId: r.unitId, cnes: r.cnes, ine: r.ine, source: 'planilha', importId },
      });
      if (r.ine) await this.joinTeam(ctx.db, r, { stagedId: row.id }, []);
    }
  }

  private async joinTeam(db: RequestContext['db'], r: ProfessionalRow, who: { userId?: string; stagedId?: string }, warnings: string[]) {
    const team = await db.team.findUnique({ where: { ine: r.ine! } });
    if (!team) {
      warnings.push(`${r.name}: equipe INE ${r.ine} não cadastrada (importe as equipes)`);
      return;
    }
    const exists = await db.teamMember.findFirst({ where: { teamId: team.id, ...(who.userId ? { userId: who.userId } : { stagedId: who.stagedId }) } });
    if (exists) await db.teamMember.update({ where: { id: exists.id }, data: { active: true, cbo: r.cbo } });
    else await db.teamMember.create({ data: { teamId: team.id, userId: who.userId ?? null, stagedId: who.stagedId ?? null, cbo: r.cbo } });
  }

  // ── Equipes (planilha) ──

  async previewTeams(ctx: RequestContext, csv: string) {
    const table = tableFromCsv(csv, TEAM_COLUMNS);
    if (!table.found.includes('ine') || !table.found.includes('cnes')) {
      throw new DomainError('PLANILHA_INVALIDA', 'A planilha precisa das colunas ine, tipo, nome e cnes (baixe o modelo)', HttpStatus.UNPROCESSABLE_ENTITY, { headers: table.headers });
    }
    const units = await ctx.db.unit.findMany({ where: { active: true }, select: { id: true, cnes: true, name: true } });
    const unitByCnes = new Map(units.map((u) => [u.cnes, u]));
    const existing = await ctx.db.team.findMany({ select: { ine: true } });
    const existingIne = new Set(existing.map((t) => t.ine));
    const rows: TeamRow[] = table.rows.map(({ line, values }) => {
      const errors: string[] = [];
      const ine = onlyDigits(values.ine ?? '').padStart(10, '0');
      if (!/^\d{10}$/.test(ine) || ine === '0000000000') errors.push('INE deve ter 10 dígitos');
      const typeCode = parseTeamType(values.type);
      if (!typeCode) errors.push('tipo de equipe desconhecido (use 70 eSF, 71 eSB, 72 eMulti, 73 eCR, 74 eAPP, 75 eMAESM ou 76 eAP)');
      const cnesDigits = onlyDigits(values.cnes ?? '');
      const cnes = cnesDigits ? cnesDigits.padStart(7, '0') : null;
      const unit = cnes ? unitByCnes.get(cnes) : undefined;
      if (!unit) errors.push(cnes ? `unidade com CNES ${cnes} não cadastrada` : 'CNES da unidade em branco');
      const name = (values.name ?? '').trim() || (typeCode && unit ? `${TEAM_TYPES[typeCode]!.sigla} ${unit.name}` : '');
      return {
        line,
        ine,
        typeCode,
        typeLabel: typeCode ? teamTypeLabel(typeCode) : null,
        name,
        cnes,
        unitId: unit?.id ?? null,
        unitName: unit?.name ?? null,
        area: str(values.area),
        status: errors.length ? 'erro' : existingIne.has(ine) ? 'atualizar' : 'nova',
        errors,
      };
    });
    const summary = { linhas: rows.length, novas: rows.filter((r) => r.status === 'nova').length, atualizar: rows.filter((r) => r.status === 'atualizar').length, erros: rows.filter((r) => r.status === 'erro').length };
    const imp = await ctx.db.cnesImport.create({ data: { kind: 'EQUIPES', source: 'planilha', summary, payload: { rows } as object, actorId: ctx.session.userId } });
    return { importId: imp.id, summary, rows, columns: table.found };
  }

  async applyTeams(ctx: RequestContext, importId: string) {
    const imp = await this.openImport(ctx, importId, 'EQUIPES');
    const { rows } = imp.payload as unknown as { rows: TeamRow[] };
    const valid = rows.filter((r) => r.status !== 'erro' && r.unitId && r.typeCode);
    if (valid.length === 0) throw new DomainError('NADA_A_IMPORTAR', 'Nenhuma linha válida na planilha', HttpStatus.UNPROCESSABLE_ENTITY);
    const result = { created: [] as string[], updated: [] as string[] };
    await ctx.db.$transaction(async (tx) => {
      for (const r of valid) {
        const data = { name: r.name, typeCode: r.typeCode!, unitId: r.unitId!, area: r.area, active: true, source: 'planilha' };
        const before = await tx.team.findUnique({ where: { ine: r.ine } });
        await tx.team.upsert({ where: { ine: r.ine }, create: { ine: r.ine, ...data }, update: data });
        (before ? result.updated : result.created).push(`${r.ine} ${r.name}`);
      }
      // Pré-cadastros que já citavam a equipe passam a integrá-la.
      const pending = await tx.cnesProfessional.findMany({ where: { status: 'PENDENTE', ine: { in: valid.map((r) => r.ine) } } });
      for (const p of pending) {
        const team = await tx.team.findUnique({ where: { ine: p.ine! } });
        if (!team) continue;
        const exists = await tx.teamMember.findFirst({ where: { teamId: team.id, stagedId: p.id } });
        if (!exists) await tx.teamMember.create({ data: { teamId: team.id, stagedId: p.id, cbo: p.cbo } });
      }
      await this.close(tx, ctx, imp.id, imp.summary, { criadas: result.created.length, atualizadas: result.updated.length }, 'cnes.equipes', result);
    });
    return result;
  }

  // ── Consultas e apoio ──

  listImports(ctx: RequestContext) {
    return ctx.db.cnesImport.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, kind: true, ibgeCode: true, source: true, status: true, summary: true, createdAt: true, appliedAt: true } });
  }

  async listStaged(ctx: RequestContext, filter: { q?: string; unitId?: string }) {
    const q = filter.q?.trim();
    const rows = await ctx.db.cnesProfessional.findMany({
      where: { status: 'PENDENTE', ...(filter.unitId ? { unitId: filter.unitId } : {}), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      include: { unit: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
      take: 300,
    });
    return rows.map((r) => ({ id: r.id, name: r.name, cpf: r.cpf, cns: r.cns, cbo: r.cbo, cboLabel: cboLabel(r.cbo) ?? null, council: r.council, unitId: r.unitId, unitName: r.unit?.name ?? null, ine: r.ine, suggestedRole: roleFromCbo(r.cbo), importedAt: r.importedAt }));
  }

  async ignoreStaged(ctx: RequestContext, id: string) {
    const row = await ctx.db.cnesProfessional.findUnique({ where: { id } });
    if (!row) throw notFound('Pré-cadastro');
    await ctx.db.$transaction(async (tx) => {
      await tx.cnesProfessional.update({ where: { id }, data: { status: 'IGNORADO' } });
      await tx.teamMember.deleteMany({ where: { stagedId: id } });
      await appendAudit(tx, { userId: ctx.session.userId, unitId: ctx.session.unitId, role: ctx.session.role, ip: ctx.ip, mfa: ctx.session.mfa, action: 'cnes.pre_cadastro_ignorar', entityType: 'CnesProfessional', entityId: id, payload: { name: row.name } });
    });
    return { ok: true };
  }

  async listTeams(ctx: RequestContext) {
    const teams = await ctx.db.team.findMany({
      include: { unit: { select: { id: true, name: true } }, _count: { select: { members: { where: { active: true } } } } },
      orderBy: [{ unit: { name: 'asc' } }, { name: 'asc' }],
    });
    return teams.map((t) => ({ id: t.id, ine: t.ine, name: t.name, typeCode: t.typeCode, typeLabel: teamTypeLabel(t.typeCode), unitId: t.unitId, unitName: t.unit.name, area: t.area, active: t.active, members: t._count.members, source: t.source }));
  }

  template(kind: 'profissionais' | 'equipes') {
    if (kind === 'profissionais') {
      return {
        fileName: 'modelo-profissionais.csv',
        content: [
          'cpf;cns;nome;cbo;cnes;ine;papel;conselho;email;telefone',
          '529.982.247-25;203456789010002;Maria da Silva Souza;223505;2546434;0000123456;ENFERMAGEM;COREN-TO 123456;maria@gurupi.to.gov.br;63999990000',
          ';;Pedro Alves Lima;515105;2546434;0000123456;;;;',
        ].join('\n'),
      };
    }
    return {
      fileName: 'modelo-equipes.csv',
      content: ['ine;tipo;nome;cnes;area', '0000123456;70;eSF Vila Nova;2546434;01', '0000123457;71;eSB Vila Nova;2546434;01'].join('\n'),
    };
  }

  private async openImport(ctx: RequestContext, id: string, kind: 'ESTABELECIMENTOS' | 'PROFISSIONAIS' | 'EQUIPES') {
    const imp = await ctx.db.cnesImport.findUnique({ where: { id } });
    if (!imp || imp.kind !== kind) throw notFound('Prévia de importação');
    if (imp.status !== 'PREVIA') throw new DomainError('IMPORTACAO_FECHADA', 'Esta prévia já foi aplicada ou cancelada; faça uma nova', HttpStatus.CONFLICT);
    const permission = kind === 'ESTABELECIMENTOS' ? 'cadastros.unidades' : 'cadastros.profissionais';
    if (!roleHasPermission(ctx.session.role, permission)) throw forbidden(`O papel ${ctx.session.role} não pode aplicar esta importação`);
    return imp;
  }

  private async close(tx: Tx, ctx: RequestContext, importId: string, summary: unknown, applied: Record<string, number>, action: string, payload: unknown) {
    await tx.cnesImport.update({ where: { id: importId }, data: { status: 'APLICADA', appliedAt: new Date(), summary: { ...(summary as object), aplicado: applied } } });
    await appendAudit(tx, { userId: ctx.session.userId, unitId: ctx.session.unitId, role: ctx.session.role, ip: ctx.ip, mfa: ctx.session.mfa, action, entityType: 'CnesImport', entityId: importId, payload });
  }
}

function byCnesIn(list: CnesEstablishment[], cnes: string) {
  return list.some((e) => e.cnes === cnes);
}

function parseRole(value: string | undefined): Role | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const upper = v.toUpperCase().replace(/\s+/g, '_');
  if (isRole(upper)) return upper;
  const hit = (Object.entries(ROLE_LABELS) as [Role, string][]).find(([, label]) => label.toLowerCase().includes(v.toLowerCase()));
  return hit ? hit[0] : null;
}

function parseTeamType(value: string | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  const code = v.replace(/\D/g, '').padStart(2, '0');
  if (TEAM_TYPES[code]) return code;
  const hit = Object.entries(TEAM_TYPES).find(([, t]) => t.sigla.toLowerCase() === v.replace(/[^a-z]/g, ''));
  return hit ? hit[0] : null;
}
