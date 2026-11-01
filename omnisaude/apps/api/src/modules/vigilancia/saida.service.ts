import { HttpStatus, Injectable } from '@nestjs/common';
import {
  CAMPOS_FIN,
  camposDeConclusao,
  CLASSIFICACAO_FINAL,
  CRITERIO_CONFIRMACAO,
  DOMINIO_FIN,
  EVOLUCAO_CASO,
  fromZonedParts,
  localDateString,
  MARCADORES_IDENTIFICACAO,
  MODELO_POLICIAL_PADRAO,
  numeracaoConclusao,
  usaConclusaoEsus,
  ROLE_LABELS,
  SISTEMA_INFO,
  type SistemaOficial,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden } from '../../core/errors';
import { formatDate, formatDateTime, renderDocument, type DocumentModel } from '../signatures/pdf';
import type { Ficha } from './ficha';
import { NotificacaoService } from './notificacao.service';

const IDADE: Record<string, string> = { H: 'hora(s)', D: 'dia(s)', M: 'mês(es)', A: 'ano(s)' };
const ddmmaaaa = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** Linha do espelho: o número e o rótulo da ficha, a variável do dicionário, o valor mostrado e o valor exportado. */
export interface LinhaEspelho {
  bloco: 'NOTIFICACAO' | 'CONCLUSAO' | 'CONCLUSAO_ESUS';
  numero: string;
  variavel: string;
  rotulo: string;
  valor: string;
  exportado: string;
}

/**
 * Saída para os sistemas oficiais (VIG-1b): espelho da ficha na ordem da FIN do Sinan Net v5, PDF para impressão,
 * exportação no layout do dicionário de dados e a comunicação à autoridade policial. Leitura com as mesmas regras de
 * alcance e sigilo da notificação; tudo auditado.
 */
@Injectable()
export class SaidaOficialService {
  constructor(
    private readonly notificacoes: NotificacaoService,
    private readonly audit: AuditService,
  ) {}

  /** Monta as linhas na ordem da ficha (campos 1 a 16 e 20 a 33) e o bloco de conclusão (31 a 43 do dicionário). */
  linhasDoEspelho(n: {
    form: unknown;
    officialNumber: string | null;
    epiWeekNotified: string | null;
    epiWeekOnset: string | null;
    symptomsOnset: Date | null;
    code: string | null;
    groupKey: string;
    investigatedAt: Date | null;
    finalClass: string | null;
    criterion: string | null;
    evolution: string | null;
    deathDate: Date | null;
    closedAt: Date | null;
    conclusion: unknown;
    condition: { sinanCode: string | null };
  }): LinhaEspelho[] {
    const f = n.form as unknown as Ficha;
    const sintomas = n.symptomsOnset?.toISOString().slice(0, 10) ?? f.DT_SIN_PRI ?? null;
    const valorDe = (campo: string): { valor: string; exportado: string } => {
      const v = (f as unknown as Record<string, unknown>)[campo];
      switch (campo) {
        case 'TP_NOT':
          return { valor: '2 - Individual', exportado: '2' };
        case 'ID_AGRAVO': {
          const cid = (n.code ?? n.condition.sinanCode ?? '').replace('.', '');
          return { valor: `${f.ID_AGRAVO.nome}${f.ID_AGRAVO.cid ? ` (${f.ID_AGRAVO.cid})` : ''}`, exportado: cid.slice(0, 4) };
        }
        case 'ID_UNIDADE':
          return { valor: `${f.ID_UNIDADE.nome} · CNES ${f.ID_UNIDADE.cnes}`, exportado: f.ID_UNIDADE.cnes };
        case 'NU_IDADE_N':
          return f.NU_IDADE_N ? { valor: `${f.NU_IDADE_N.valor} ${IDADE[f.NU_IDADE_N.unidade] ?? ''}`, exportado: f.NU_IDADE_N.codigo } : { valor: '', exportado: '' };
        case 'DT_SIN_PRI':
          return { valor: ddmmaaaa(sintomas), exportado: ddmmaaaa(sintomas) };
        case 'SG_UF_NOT':
          return { valor: String(f.SG_UF_NOT ?? ''), exportado: digitos(f.ID_MUNICIP).slice(0, 2) };
        case 'SG_UF':
          return { valor: String(f.SG_UF ?? ''), exportado: digitos(f.ID_MN_RESI).slice(0, 2) };
        case 'ID_MUNICIP':
        case 'ID_MN_RESI':
          // O Sinan usa o código IBGE de 6 dígitos (sem o dígito verificador).
          return { valor: String(v ?? ''), exportado: digitos(v).slice(0, 6) };
        case 'CS_ESCOL_N':
          return { valor: v ? `${String(v)} - ${DOMINIO_FIN.CS_ESCOL_N?.[String(v)] ?? ''}` : '', exportado: v ? String(v).padStart(2, '0') : '' };
        case 'NU_TELEFON':
          return { valor: String(v ?? ''), exportado: digitos(v).slice(-9) };
        case 'NU_CEP':
          return { valor: String(v ?? ''), exportado: digitos(v) };
      }
      if (campo.startsWith('DT_')) return { valor: ddmmaaaa(v as string), exportado: ddmmaaaa(v as string) };
      const dom = DOMINIO_FIN[campo];
      if (dom && v) return { valor: `${String(v)} - ${dom[String(v)] ?? ''}`, exportado: String(v) };
      return { valor: v === null || v === undefined ? '' : String(v), exportado: v === null || v === undefined ? '' : String(v) };
    };
    const linhas: LinhaEspelho[] = [{ bloco: 'NOTIFICACAO', numero: 'Nº', variavel: 'NU_NOTIFIC', rotulo: 'Número da notificação', valor: n.officialNumber ?? '', exportado: n.officialNumber ?? '' }];
    for (const c of CAMPOS_FIN) {
      linhas.push({ bloco: 'NOTIFICACAO', numero: String(c.numero), variavel: c.campo, rotulo: c.rotulo, ...valorDe(c.campo) });
      if (c.campo === 'DT_NOTIFIC')
        linhas.push({ bloco: 'NOTIFICACAO', numero: '—', variavel: 'SEM_NOT', rotulo: 'Semana epidemiológica da notificação', valor: n.epiWeekNotified ?? '', exportado: n.epiWeekNotified ?? '' });
      if (c.campo === 'DT_SIN_PRI')
        linhas.push({ bloco: 'NOTIFICACAO', numero: '—', variavel: 'SEM_PRI', rotulo: 'Semana epidemiológica dos primeiros sintomas', valor: n.epiWeekOnset ?? '', exportado: n.epiWeekOnset ?? '' });
      if (c.campo === 'NU_TELEFON') {
        const ddd = digitos(f.NU_TELEFON).replace(/^55/, '').slice(0, 2);
        linhas.push({ bloco: 'NOTIFICACAO', numero: '31', variavel: 'NU_DDD_TEL', rotulo: 'DDD', valor: ddd, exportado: ddd });
      }
    }
    const dia = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
    const num = numeracaoConclusao(n.groupKey);
    const esus = usaConclusaoEsus(n.groupKey);
    const conclusao: [string, string, string, string][] = [
      [num.investigacao, 'DT_INVEST', 'Data da investigação', ddmmaaaa(dia(n.investigatedAt))],
      [num.classificacao, 'CLASSI_FIN', 'Classificação final', n.finalClass ?? ''],
      [num.criterio, 'CRITERIO', 'Critério de confirmação/descarte', n.criterion ?? ''],
      [num.evolucao, 'EVOLUCAO', 'Evolução do caso', n.evolution ?? ''],
      [num.obito, 'DT_OBITO', 'Data do óbito', ddmmaaaa(dia(n.deathDate))],
      // No e-SUS Sinan, o campo 56 é a "data de conclusão" (DT_CONCLU); no Sinan Net, a data do encerramento.
      [num.encerramento, esus ? 'DT_CONCLU' : 'DT_ENCERRA', esus ? 'Data de conclusão' : 'Data do encerramento', ddmmaaaa(dia(n.closedAt))],
    ];
    const rotuloDe: Record<string, Record<string, string>> = { CLASSI_FIN: CLASSIFICACAO_FINAL, CRITERIO: CRITERIO_CONFIRMACAO, EVOLUCAO: EVOLUCAO_CASO };
    for (const [numero, variavel, rotulo, valor] of conclusao) {
      linhas.push({ bloco: 'CONCLUSAO', numero, variavel, rotulo, valor: valor && rotuloDe[variavel] ? `${valor} - ${rotuloDe[variavel]![valor] ?? ''}` : valor, exportado: valor });
    }
    const extra = (n.conclusion as Record<string, string> | null) ?? {};
    for (const c of camposDeConclusao(n.groupKey)) {
      const v = extra[c.campo] ?? '';
      linhas.push({ bloco: 'CONCLUSAO_ESUS', numero: c.campo, variavel: `CAMPO_${c.campo}`, rotulo: c.rotulo, valor: v && c.opcoes?.[v] ? `${v} - ${c.opcoes[v]}` : c.tipo === 'data' ? ddmmaaaa(v) : v, exportado: v });
    }
    return linhas;
  }

  async espelho(ctx: RequestContext, id: string) {
    const n = await this.notificacoes.acessar(ctx, id, { leitura: true });
    return {
      numero: n.number,
      sistema: n.officialSystem,
      sistemaLabel: n.officialSystem ? SISTEMA_INFO[n.officialSystem as SistemaOficial].label : null,
      formVersion: (n.form as unknown as Ficha).formVersion,
      linhas: this.linhasDoEspelho(n),
    };
  }

  /** PDF da ficha para impressão ou para apoiar a digitação: os campos na ordem da FIN v5 e a conclusão. */
  async fichaPdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const n = await this.notificacoes.acessar(ctx, id, { leitura: true });
    const linhas = this.linhasDoEspelho(n);
    const model = await this.modelo(ctx, n, `Ficha individual de notificação · ${(n.form as unknown as Ficha).ID_AGRAVO.nome}`);
    const bloco = (b: LinhaEspelho['bloco']) => linhas.filter((l) => l.bloco === b).map((l) => `${l.numero}. ${l.rotulo} [${l.variavel}]: ${l.valor || '—'}`);
    model.sections = [
      { heading: 'Notificação (Sinan Net v5, campos 1 a 16 e 20 a 33)', paragraphs: bloco('NOTIFICACAO') },
      { heading: 'Investigação e conclusão', paragraphs: bloco('CONCLUSAO') },
      ...(linhas.some((l) => l.bloco === 'CONCLUSAO_ESUS') ? [{ heading: 'Conclusão do e-SUS Sinan', paragraphs: bloco('CONCLUSAO_ESUS') }] : []),
    ];
    const data = await renderDocument(model);
    await this.audit.recordStandalone(ctx, { action: 'notificacao.ficha_pdf', entityType: 'Notification', entityId: n.id, payload: { numero: n.number } });
    return { data, fileName: `notificacao-${n.number.replace('/', '-')}.pdf` };
  }

  /** Comunicação à autoridade policial (violência contra a mulher), no modelo definido pela instituição. */
  async comunicacaoPolicialPdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const n = await this.notificacoes.acessar(ctx, id, { leitura: true });
    if (!n.policeRequired) throw new DomainError('SEM_COMUNICACAO_POLICIAL', 'Esta notificação não exige comunicação à autoridade policial', HttpStatus.UNPROCESSABLE_ENTITY);
    const [patient, unit] = await Promise.all([ctx.db.patient.findUniqueOrThrow({ where: { id: n.patientId } }), ctx.db.unit.findUniqueOrThrow({ where: { id: n.unitId } })]);
    const valores: Record<string, string> = {
      unidade: unit.name,
      cnes: unit.cnes,
      atendimento: formatDateTime(n.firstCareAt ?? n.knownAt, ctx.tenant.timeZone),
      numero: n.number,
      paciente: patient.socialName ?? patient.name,
      nascimento: formatDate(patient.birthDate),
      endereco: [patient.street, patient.number, patient.district].filter(Boolean).join(', '),
    };
    const modelo = ctx.tenant.settings.vigilancia.modeloPolicial ?? MODELO_POLICIAL_PADRAO;
    // Sem identificação da vítima, salvo se o modelo da instituição pedir (Lei nº 10.778/2003, art. 3º, parágrafo único).
    const identifica = MARCADORES_IDENTIFICACAO.some((k) => modelo.includes(`{${k}}`));
    const texto = modelo.replace(/\{(\w+)\}/g, (m, k: string) => valores[k] ?? m);
    const model = await this.modelo(ctx, n, 'Comunicação à autoridade policial');
    // Nunca o cabeçalho do paciente (nome, CPF, CNS): a identificação, quando a instituição a decide, sai só pelos
    // marcadores que o modelo usa.
    model.patient = null;
    model.sections = [{ paragraphs: texto.split('\n').filter((l) => l.trim()) }];
    const data = await renderDocument(model);
    await this.audit.recordStandalone(ctx, { action: 'notificacao.comunicacao_policial_pdf', entityType: 'Notification', entityId: n.id, payload: { numero: n.number, identificaVitima: identifica } });
    return { data, fileName: `comunicacao-policial-${n.number.replace('/', '-')}.pdf` };
  }

  private async modelo(ctx: RequestContext, n: { patientId: string; unitId: string; notifierId: string; notifierCbo: string | null; notifierRole: string; number: string }, titulo: string): Promise<DocumentModel> {
    const [patient, unit, autor, assinante] = await Promise.all([
      ctx.db.patient.findUniqueOrThrow({ where: { id: n.patientId } }),
      ctx.db.unit.findUniqueOrThrow({ where: { id: n.unitId } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: n.notifierId }, select: { name: true, socialName: true } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, cpf: true } }),
    ]);
    return {
      title: titulo,
      unit: { name: unit.name, cnes: unit.cnes, address: unit.address },
      patient: { name: patient.socialName ?? patient.name, cpf: patient.cpf, cns: patient.cns, birthDate: patient.birthDate },
      professional: { name: autor.socialName ?? autor.name, council: null, cbo: n.notifierCbo ?? '', roleLabel: ROLE_LABELS[n.notifierRole as keyof typeof ROLE_LABELS] ?? n.notifierRole },
      issuedAt: new Date(),
      timeZone: ctx.tenant.timeZone,
      sections: [],
      footer: [`Notificação ${n.number} · emitido em ${formatDateTime(new Date(), ctx.tenant.timeZone)} por ${assinante.name} · documento de apoio, não substitui o registro no sistema oficial`],
      signer: { name: assinante.name, cpf: assinante.cpf },
    };
  }

  /**
   * Exportação CSV no layout do dicionário de dados do Sinan Net v5 (variáveis DBF): datas dd/mm/aaaa, município com
   * 6 dígitos, CID sem ponto, SEM_NOT e SEM_PRI em AAAASS. Lista nominal: só a vigilância municipal, auditada.
   */
  async exportarCsv(ctx: RequestContext, q: { sistema?: SistemaOficial; de: string; ate: string; situacao?: 'PENDENTE' | 'DIGITADA' }) {
    if (ctx.session.role !== 'VIGILANCIA_EPIDEMIOLOGICA') throw forbidden('A exportação nominal é da vigilância municipal');
    if (q.ate < q.de) throw new DomainError('PERIODO_INVALIDO', 'Período inválido', HttpStatus.BAD_REQUEST);
    // Período em dias locais da instituição (DT_NOTIFIC é a data local da notificação).
    const tz = ctx.tenant.timeZone;
    const inicioDoDia = (iso: string) => fromZonedParts({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)), hour: 0, minute: 0, second: 0 }, tz);
    const diaSeguinte = (iso: string) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + 1)).toISOString().slice(0, 10);
    const where = {
      ...this.notificacoes.escopo(ctx),
      status: { in: ['NOTIFICADA' as const, 'ENCERRADA' as const] },
      notifiedAt: { gte: inicioDoDia(q.de), lt: inicioDoDia(diaSeguinte(q.ate)) },
      ...(q.sistema ? { officialSystem: q.sistema } : {}),
      // Sem filtro de situação: tudo o que tem ficha (lembretes de DNV/DO não têm).
      ...(q.situacao ? { entryStatus: q.situacao } : { OR: [{ entryStatus: null }, { entryStatus: { in: ['PENDENTE' as const, 'DIGITADA' as const] } }] }),
    };
    const total = await ctx.db.notification.count({ where });
    if (total > LIMITE_EXPORTACAO) throw new DomainError('EXPORTACAO_GRANDE', `O período tem ${total} notificações; exporte períodos menores (até ${LIMITE_EXPORTACAO} por arquivo)`, HttpStatus.UNPROCESSABLE_ENTITY);
    const rows = await ctx.db.notification.findMany({ where, orderBy: { notifiedAt: 'asc' }, include: { condition: true } });
    const linhas = rows.map((n) => this.linhasDoEspelho(n).filter((l) => l.bloco !== 'CONCLUSAO_ESUS'));
    // Cabeçalho fixo (o mesmo para qualquer mistura de sistemas): as variáveis do Sinan Net, com DT_CONCLU (data de
    // conclusão do e-SUS Sinan) logo depois de DT_ENCERRA.
    const variaveis = this.linhasDoEspelho(VAZIA)
      .filter((l) => l.bloco !== 'CONCLUSAO_ESUS')
      .flatMap((l) => (l.variavel === 'DT_ENCERRA' ? ['DT_ENCERRA', 'DT_CONCLU'] : [l.variavel]));
    const extras = ['NU_ANO', 'SISTEMA', 'NUMERO_OMNI'];
    // Texto que a planilha leria como fórmula (=, +, -, @, tabulação) vai com apóstrofo na frente.
    const esc = (v: string) => {
      const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
      return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const corpo = rows.map((n, i) => {
      const porVar = new Map(linhas[i]!.map((l) => [l.variavel, l.exportado]));
      return [...variaveis.map((v) => porVar.get(v) ?? ''), localDateString(n.notifiedAt ?? n.knownAt, tz).slice(0, 4), n.officialSystem ?? '', n.number].map(esc).join(';');
    });
    const csv = [[...variaveis, ...extras].join(';'), ...corpo].join('\r\n');
    // A trilha guarda só o hash do conteúdo: cada notificação sigilosa exportada ganha a própria entrada (consultável
    // pela entidade), na mesma transação do registro da exportação.
    const sigilosas = rows.filter((r) => r.sensitive).map((r) => r.id);
    await ctx.db.$transaction(
      async (tx) => {
        await this.audit.record(ctx, tx, {
          action: 'notificacao.exportar',
          entityType: 'Notification',
          payload: { sistema: q.sistema ?? null, situacao: q.situacao ?? null, de: q.de, ate: q.ate, linhas: rows.length, sigilosas: sigilosas.length },
        });
        await this.audit.recordMany(
          ctx,
          tx,
          sigilosas.map((id) => ({ action: 'notificacao.exportar_sensivel', entityType: 'Notification', entityId: id, payload: { de: q.de, ate: q.ate } })),
        );
      },
      { timeout: 60_000 },
    );
    return { content: csv, fileName: `notificacoes-${q.sistema ?? 'todas'}-${q.de}-a-${q.ate}.csv`, linhas: rows.length };
  }
}

/** Teto de linhas por arquivo da exportação (acima disso, pede-se um período menor). */
const LIMITE_EXPORTACAO = 20_000;

/** Notificação vazia para montar o cabeçalho da exportação (variáveis do Sinan Net). */
const VAZIA = {
  form: { ID_AGRAVO: { nome: '', cid: null, item: 0, subitem: null }, ID_UNIDADE: { nome: '', cnes: '' }, NU_IDADE_N: null },
  officialNumber: null,
  epiWeekNotified: null,
  epiWeekOnset: null,
  symptomsOnset: null,
  code: null,
  groupKey: '',
  investigatedAt: null,
  finalClass: null,
  criterion: null,
  evolution: null,
  deathDate: null,
  closedAt: null,
  conclusion: null,
  condition: { sinanCode: null },
};
