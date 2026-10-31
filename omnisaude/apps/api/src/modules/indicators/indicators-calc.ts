import {
  ageInYears,
  CBO_C1,
  CBO_DENTISTA_PREFIXO,
  CBO_MEDICO_ENFERMEIRO_PREFIXOS,
  CBO_TSB_PREFIXO,
  CIAP_ABORTO,
  CIAP_DIABETES,
  CIAP_GESTACAO,
  CIAP_HIPERTENSAO,
  CIAP_SSR,
  CID_ABORTO_PREFIXOS,
  CID_DIABETES_PREFIXOS,
  CID_GESTACAO_PREFIXOS,
  CID_HIPERTENSAO_PREFIXOS,
  CID_SSR_PREFIXOS,
  INDICADOR_POR_CODIGO,
  SIGTAP_APS,
  type BoaPratica,
  type CodigoIndicador,
  type ComponenteVacinal,
} from '@omnisaude/shared';

/**
 * Apuração dos indicadores do componente de qualidade a partir dos registros do OmniSaúde.
 * Funções puras sobre os dados já carregados de uma equipe (ver indicators.service.ts), para que o
 * cálculo possa ser conferido manualmente e testado sem banco.
 */

const DIA = 86_400_000;
const MES = 30.4375 * DIA;

export interface Pessoa {
  id: string;
  name: string;
  birthDate: Date;
  sex: string;
  bolsaFamilia?: boolean;
  /** Data do cadastro: a pessoa só conta nos meses em que já estava cadastrada. */
  cadastradoEm: Date;
}
export interface Consulta {
  patientId: string;
  encounterId: string;
  authorId: string;
  cbo: string;
  at: Date;
  codes: string[];
  kind: string;
  /** Atendimento com agendamento prévio (demanda programada). */
  programada: boolean;
  /** Conduta registrada no odontograma, quando houver. */
  conduta?: string | null;
}
export interface Medicao {
  patientId: string;
  at: Date;
  pa: boolean;
  pesoAltura: boolean;
  peso?: number | null;
  altura?: number | null;
}
export interface Exame {
  patientId: string;
  code: string;
  analyte: string | null;
  requestedAt: Date;
  resultAt: Date | null;
}
export interface Vacina {
  patientId: string;
  componentes: ComponenteVacinal[];
  at: Date;
}
export interface Procedimento {
  patientId: string | null;
  professionalId: string;
  cbo: string;
  code: string;
  quantity: number;
  at: Date;
}
export interface Condicao {
  patientId: string;
  system: string;
  code: string;
  lineOfCare: string | null;
  onsetAt: Date | null;
  recordedAt: Date;
  active: boolean;
  resolvedAt: Date | null;
}
/** Visita domiciliar do ACS/TACS (fonte prevista para o app do ACS, APS-3). */
export interface Visita {
  patientId: string;
  at: Date;
}

export interface DadosEquipe {
  team: { id: string; typeCode: string; name: string };
  membros: Set<string>;
  pessoas: Pessoa[];
  /** Registros assinados de pessoas vinculadas (qualquer profissional) e dos membros da equipe. */
  consultas: Consulta[];
  medicoes: Medicao[];
  exames: Exame[];
  vacinas: Vacina[];
  procedimentos: Procedimento[];
  condicoes: Condicao[];
  visitas: Visita[];
  /** Autores dos registros assinados por atendimento (para ações compartilhadas da eMulti). */
  coautores: Map<string, Set<string>>;
  /** eSB: pessoas vinculadas às eSF/eAP de referência (mesma unidade). */
  referencia: { total: number; criancas6a12: number };
}

export interface Mes {
  competencia: string;
  inicio: Date;
  /** Exclusivo. */
  fim: Date;
  /** Data de corte dos registros (fim do mês ou agora, no mês corrente). */
  asOf: Date;
  /** Data local do corte (AAAA-MM-DD), para comparar com datas sem hora (nascimento, DUM). */
  asOfLocal: string;
}

export interface ResultadoMes {
  competencia: string;
  valor: number | null;
  numerador: number;
  denominador: number;
  /** Detalhes por boa prática ou subgrupo (pontos obtidos / pontos possíveis, ou numerador/denominador). */
  detalhe?: Record<string, { obtido: number; possivel: number }>;
}

export interface Pendencia {
  patientId: string;
  nome: string;
  idade: number;
  sexo: string;
  pontos: number;
  maximo: number;
  faltam: { letra: string; descricao: string; pontos: number }[];
  observacao?: string;
}

// ───────────────────────────── utilidades ─────────────────────────────

const addDias = (d: Date, n: number) => new Date(d.getTime() + n * DIA);
const addMeses = (d: Date, n: number) => new Date(d.getTime() + n * MES);
const entre = (d: Date, inicio: Date, fim: Date) => d.getTime() >= inicio.getTime() && d.getTime() <= fim.getTime();
const prefixo = (code: string, prefixos: readonly string[]) => prefixos.some((p) => code.startsWith(p));
const normCode = (c: string) =>
  c
    .toUpperCase()
    .replace(/^(CID10|CIAP2|CID11):/, '')
    .replace('.', '');
const ehMedicoOuEnfermeiro = (cbo: string) => CBO_MEDICO_ENFERMEIRO_PREFIXOS.some((p) => cbo.startsWith(p));
const ehSaudeBucal = (cbo: string) => cbo.startsWith(CBO_DENTISTA_PREFIXO) || cbo.startsWith(CBO_TSB_PREFIXO);
const condicaoBate = (c: Condicao, cids: readonly string[], ciaps: readonly string[]) => {
  const code = normCode(c.code);
  return c.system === 'CIAP2' ? ciaps.includes(code) : prefixo(code, cids);
};
const codesBatem = (codes: string[], cids: readonly string[], ciaps: readonly string[]) =>
  codes.some((raw) => {
    const code = normCode(raw);
    return raw.toUpperCase().startsWith('CIAP2:') ? ciaps.includes(code) : prefixo(code, cids);
  });
export const idade = (p: Pessoa, at: Date) => ageInYears(p.birthDate, at);
const dataIso = (d: Date) => d.toISOString().slice(0, 10);
/** Segundo aniversário como data sem hora (AAAA-MM-DD). */
const segundoAniversario = (nasc: Date) => dataIso(new Date(Date.UTC(nasc.getUTCFullYear() + 2, nasc.getUTCMonth(), nasc.getUTCDate())));
export const cadastradas = (pessoas: Pessoa[], asOf: Date) => pessoas.filter((p) => p.cadastradoEm.getTime() <= asOf.getTime());
const nomeIdade = (p: Pessoa, at: Date) => ({ patientId: p.id, nome: p.name, idade: idade(p, at), sexo: p.sex });

/** Doses com intervalo mínimo de 30 dias entre si. */
export function dosesValidas(datas: Date[], minimo: Date | null = null): number {
  const ordenadas = datas.filter((d) => !minimo || d.getTime() >= minimo.getTime()).sort((a, b) => a.getTime() - b.getTime());
  let n = 0;
  let ultima: Date | null = null;
  for (const d of ordenadas) {
    if (!ultima || d.getTime() - ultima.getTime() >= 30 * DIA) {
      n++;
      ultima = d;
    }
  }
  return n;
}

export class Indice {
  readonly consultas = new Map<string, Consulta[]>();
  readonly medicoes = new Map<string, Medicao[]>();
  readonly exames = new Map<string, Exame[]>();
  readonly vacinas = new Map<string, Vacina[]>();
  readonly procedimentos = new Map<string, Procedimento[]>();
  readonly condicoes = new Map<string, Condicao[]>();
  readonly visitas = new Map<string, Visita[]>();
  constructor(readonly dados: DadosEquipe) {
    const push = <T>(m: Map<string, T[]>, k: string | null, v: T) => {
      if (!k) return;
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };
    for (const c of dados.consultas) push(this.consultas, c.patientId, c);
    for (const m of dados.medicoes) push(this.medicoes, m.patientId, m);
    for (const e of dados.exames) push(this.exames, e.patientId, e);
    for (const v of dados.vacinas) push(this.vacinas, v.patientId, v);
    for (const p of dados.procedimentos) push(this.procedimentos, p.patientId, p);
    for (const c of dados.condicoes) push(this.condicoes, c.patientId, c);
    for (const v of dados.visitas) push(this.visitas, v.patientId, v);
  }
  /** Consultas por médico ou enfermeiro no intervalo (inclusive), respeitando o corte. */
  consultasMedEnf(pid: string, inicio: Date, fim: Date, corte: Date) {
    const f = fim.getTime() < corte.getTime() ? fim : corte;
    return (this.consultas.get(pid) ?? []).filter((c) => (c.kind === 'SOAP' || c.kind === 'EVOLUCAO') && ehMedicoOuEnfermeiro(c.cbo) && entre(c.at, inicio, f));
  }
  pa(pid: string, inicio: Date, fim: Date, corte: Date) {
    const f = fim.getTime() < corte.getTime() ? fim : corte;
    return (this.medicoes.get(pid) ?? []).filter((m) => m.pa && entre(m.at, inicio, f));
  }
  pesoAltura(pid: string, inicio: Date, fim: Date, corte: Date) {
    const f = fim.getTime() < corte.getTime() ? fim : corte;
    return (this.medicoes.get(pid) ?? []).filter((m) => m.pesoAltura && entre(m.at, inicio, f));
  }
  /** Exame solicitado ou avaliado (resultado) no intervalo. */
  exame(pid: string, codes: readonly string[], inicio: Date, fim: Date, corte: Date, analyte?: string) {
    const f = fim.getTime() < corte.getTime() ? fim : corte;
    return (this.exames.get(pid) ?? []).some(
      (e) => (codes.includes(e.code) || (analyte !== undefined && e.analyte === analyte)) && (entre(e.requestedAt, inicio, f) || (e.resultAt !== null && entre(e.resultAt, inicio, f))),
    );
  }
  procedimento(pid: string, codes: readonly string[], inicio: Date, fim: Date, corte: Date, cboFiltro?: (cbo: string) => boolean) {
    const f = fim.getTime() < corte.getTime() ? fim : corte;
    return (this.procedimentos.get(pid) ?? []).some((p) => codes.includes(p.code) && entre(p.at, inicio, f) && (!cboFiltro || cboFiltro(p.cbo)));
  }
  vacinasCom(pid: string, componente: ComponenteVacinal, inicio: Date, fim: Date, corte: Date) {
    const f = fim.getTime() < corte.getTime() ? fim : corte;
    return (this.vacinas.get(pid) ?? []).filter((v) => v.componentes.includes(componente) && entre(v.at, inicio, f)).map((v) => v.at);
  }
  visitasEm(pid: string, inicio: Date, fim: Date, corte: Date) {
    const f = fim.getTime() < corte.getTime() ? fim : corte;
    return (this.visitas.get(pid) ?? []).filter((v) => entre(v.at, inicio, f)).map((v) => v.at);
  }
  /** Condições ativas na data (não resolvidas antes dela). */
  condicoesAtivas(pid: string, at: Date) {
    return (this.condicoes.get(pid) ?? []).filter((c) => c.recordedAt.getTime() <= at.getTime() && (c.active || (c.resolvedAt !== null && c.resolvedAt.getTime() > at.getTime())));
  }
}

// ───────────────────────────── boas práticas por pessoa ─────────────────────────────

export interface Pontuacao {
  pontos: number;
  maximo: number;
  obtidas: BoaPratica[];
  faltam: BoaPratica[];
}

function pontuar(praticas: BoaPratica[], cumpre: (bp: BoaPratica) => boolean, eAp: boolean): Pontuacao {
  const r: Pontuacao = { pontos: 0, maximo: 0, obtidas: [], faltam: [] };
  for (const bp of praticas) {
    r.maximo += bp.pontos;
    if ((eAp && bp.eapIntegral) || cumpre(bp)) {
      r.pontos += bp.pontos;
      r.obtidas.push(bp);
    } else r.faltam.push(bp);
  }
  return r;
}

const praticas = (codigo: CodigoIndicador) => INDICADOR_POR_CODIGO[codigo].boasPraticas ?? [];

/** C2: criança avaliada até os dois anos de vida (ou até o corte, se antes). */
export function pontuarCrianca(ix: Indice, p: Pessoa, corte: Date, eAp: boolean): Pontuacao {
  const nasc = p.birthDate;
  const doisAnos = new Date(Date.UTC(nasc.getUTCFullYear() + 2, nasc.getUTCMonth(), nasc.getUTCDate(), 23, 59, 59));
  const fim = doisAnos.getTime() < corte.getTime() ? doisAnos : corte;
  return pontuar(
    praticas('C2'),
    (bp) => {
      switch (bp.letra) {
        case 'A':
          return ix.consultasMedEnf(p.id, nasc, addDias(nasc, 30), corte).length > 0;
        case 'B':
          return ix.consultasMedEnf(p.id, nasc, fim, corte).length >= 9;
        case 'C':
          return ix.pesoAltura(p.id, nasc, fim, corte).length >= 9;
        case 'D': {
          const v = ix.visitasEm(p.id, nasc, fim, corte);
          return v.some((d) => d.getTime() <= addDias(nasc, 30).getTime()) && v.some((d) => d.getTime() > addDias(nasc, 30).getTime() && d.getTime() <= addMeses(nasc, 6).getTime());
        }
        case 'E': {
          const doses = (c: ComponenteVacinal, minimo: Date | null = null) => dosesValidas(ix.vacinasCom(p.id, c, nasc, fim, corte), minimo);
          return doses('DTP') >= 3 && doses('HEPB') >= 3 && doses('HIB') >= 3 && doses('VIP') >= 3 && doses('SCR', addMeses(nasc, 12)) >= 2 && doses('PNEUMO') >= 2;
        }
        default:
          return false;
      }
    },
    eAp,
  );
}

export interface Gestacao {
  patientId: string;
  dum: Date;
  fimGestacao: Date;
  fimPuerperio: Date;
  desfechoRegistrado: boolean;
}

/** Gestações identificadas pelas condições (DUM = início da condição; sem desfecho, 294 dias). */
export function gestacoes(ix: Indice): Gestacao[] {
  const out: Gestacao[] = [];
  for (const [pid, conds] of ix.condicoes) {
    for (const c of conds) {
      if (!(c.lineOfCare === 'GESTANTE' || condicaoBate(c, CID_GESTACAO_PREFIXOS, CIAP_GESTACAO))) continue;
      const dum = c.onsetAt ?? c.recordedAt;
      const fimGestacao = c.resolvedAt ?? addDias(dum, 294);
      // Puerpério até o fim do 42º dia após o desfecho.
      const fimPuerperio = new Date(addDias(fimGestacao, 43).getTime() - 1);
      const aborto = conds.some((a) => condicaoBate(a, CID_ABORTO_PREFIXOS, CIAP_ABORTO) && entre(a.recordedAt, dum, fimPuerperio));
      if (aborto) continue;
      // Duas condições de gestação sobrepostas (ex.: CIAP e CID no mesmo pré-natal) contam uma vez.
      if (out.some((g) => g.patientId === pid && Math.abs(g.dum.getTime() - dum.getTime()) < 120 * DIA)) continue;
      out.push({ patientId: pid, dum, fimGestacao, fimPuerperio, desfechoRegistrado: c.resolvedAt !== null });
    }
  }
  return out;
}

export function pontuarGestacao(ix: Indice, g: Gestacao, corte: Date, eAp: boolean): Pontuacao {
  const { dum, fimGestacao: fimG, fimPuerperio: fimP } = g;
  const pid = g.patientId;
  const t1 = addDias(dum, 91);
  const t3 = addDias(dum, 196);
  const testes = (grupos: readonly (readonly string[])[], inicio: Date, fim: Date) => grupos.every((codes) => ix.exame(pid, codes, inicio, fim, corte));
  return pontuar(
    praticas('C3'),
    (bp) => {
      switch (bp.letra) {
        case 'A':
          return ix.consultasMedEnf(pid, dum, addDias(dum, 84), corte).length > 0;
        case 'B':
          return ix.consultasMedEnf(pid, dum, fimG, corte).length >= 7;
        case 'C':
          return ix.pa(pid, dum, fimG, corte).length >= 7;
        case 'D':
          return ix.pesoAltura(pid, dum, fimG, corte).length >= 7;
        case 'E': {
          const primeira = ix
            .consultasMedEnf(pid, dum, fimG, corte)
            .map((c) => c.at.getTime())
            .sort((a, b) => a - b)[0];
          return primeira !== undefined && ix.visitasEm(pid, new Date(primeira), fimG, corte).length >= 3;
        }
        case 'F':
          return ix.vacinasCom(pid, 'DTPA_ADULTO', addDias(dum, 140), fimG, corte).length > 0;
        case 'G':
          return testes([SIGTAP_APS.TESTES_SIFILIS, SIGTAP_APS.TESTES_HIV, SIGTAP_APS.TESTES_HEPATITE_B, SIGTAP_APS.TESTES_HEPATITE_C], dum, t1);
        case 'H':
          return testes([SIGTAP_APS.TESTES_SIFILIS, SIGTAP_APS.TESTES_HIV], t3, fimG);
        case 'I':
          return ix.consultasMedEnf(pid, fimG, fimP, corte).length > 0;
        case 'J':
          return ix.visitasEm(pid, fimG, fimP, corte).length > 0;
        case 'K': {
          const f = fimG.getTime() < corte.getTime() ? fimG : corte;
          const odonto = (ix.consultas.get(pid) ?? []).some((c) => ehSaudeBucal(c.cbo) && entre(c.at, dum, f));
          return odonto || (ix.procedimentos.get(pid) ?? []).some((p) => ehSaudeBucal(p.cbo) && entre(p.at, dum, f));
        }
        default:
          return false;
      }
    },
    eAp,
  );
}

export function pontuarCronico(codigo: 'C4' | 'C5', ix: Indice, p: Pessoa, asOf: Date, eAp: boolean): Pontuacao {
  const m6 = addMeses(asOf, -6);
  const m12 = addMeses(asOf, -12);
  return pontuar(
    praticas(codigo),
    (bp) => {
      switch (bp.letra) {
        case 'A':
          return ix.consultasMedEnf(p.id, m6, asOf, asOf).length > 0;
        case 'B':
          return ix.pa(p.id, m6, asOf, asOf).length > 0;
        case 'C':
          return ix.pesoAltura(p.id, m12, asOf, asOf).length > 0;
        case 'D':
          return dosesValidas(ix.visitasEm(p.id, m12, asOf, asOf)) >= 2;
        case 'E':
          return ix.exame(p.id, [SIGTAP_APS.HEMOGLOBINA_GLICADA], m12, asOf, asOf, 'HBA1C');
        case 'F':
          return ix.procedimento(p.id, [SIGTAP_APS.EXAME_PE_DIABETICO], m12, asOf, asOf);
        default:
          return false;
      }
    },
    eAp,
  );
}

export function pontuarIdoso(ix: Indice, p: Pessoa, asOf: Date, eAp: boolean): Pontuacao {
  const m12 = addMeses(asOf, -12);
  return pontuar(
    praticas('C6'),
    (bp) => {
      switch (bp.letra) {
        case 'A':
          return ix.consultasMedEnf(p.id, m12, asOf, asOf).length > 0;
        case 'B':
          return ix.pesoAltura(p.id, m12, asOf, asOf).length > 0;
        case 'C':
          return dosesValidas(ix.visitasEm(p.id, m12, asOf, asOf)) >= 2;
        case 'D':
          return ix.vacinasCom(p.id, 'INFLUENZA', m12, asOf, asOf).length > 0;
        default:
          return false;
      }
    },
    eAp,
  );
}

/** C7: cada boa prática tem a própria faixa etária; a pessoa é avaliada só nas faixas em que está. */
export function praticasC7Aplicaveis(p: Pessoa, asOf: Date): BoaPratica[] {
  const a = idade(p, asOf);
  if (p.sex !== 'F') return [];
  return praticas('C7').filter((bp) => (bp.letra === 'A' && a >= 25 && a <= 64) || (bp.letra === 'B' && a >= 9 && a <= 14) || (bp.letra === 'C' && a >= 14 && a <= 69) || (bp.letra === 'D' && a >= 50 && a <= 69));
}

export function cumpreC7(ix: Indice, p: Pessoa, bp: BoaPratica, asOf: Date): boolean {
  switch (bp.letra) {
    case 'A':
      return (
        ix.exame(p.id, SIGTAP_APS.CITOPATOLOGICO, addMeses(asOf, -36), asOf, asOf) ||
        ix.procedimento(p.id, SIGTAP_APS.CITOPATOLOGICO, addMeses(asOf, -36), asOf, asOf) ||
        ix.exame(p.id, [SIGTAP_APS.HPV_MOLECULAR], addMeses(asOf, -60), asOf, asOf) ||
        ix.procedimento(p.id, [SIGTAP_APS.HPV_MOLECULAR], addMeses(asOf, -60), asOf, asOf)
      );
    case 'B':
      return ix.vacinasCom(p.id, 'HPV', p.birthDate, asOf, asOf).some((d) => {
        const i = ageInYears(p.birthDate, d);
        return i >= 9 && i <= 14;
      });
    case 'C':
      return ix.consultasMedEnf(p.id, addMeses(asOf, -12), asOf, asOf).some((c) => codesBatem(c.codes, CID_SSR_PREFIXOS, CIAP_SSR));
    case 'D':
      return ix.exame(p.id, SIGTAP_APS.MAMOGRAFIA, addMeses(asOf, -24), asOf, asOf) || ix.procedimento(p.id, SIGTAP_APS.MAMOGRAFIA, addMeses(asOf, -24), asOf, asOf);
    default:
      return false;
  }
}

// ───────────────────────────── populações ─────────────────────────────

export const cronicos = (ix: Indice, codigo: 'C4' | 'C5', asOf: Date) => {
  const [cids, ciaps] = codigo === 'C4' ? [CID_DIABETES_PREFIXOS, CIAP_DIABETES] : [CID_HIPERTENSAO_PREFIXOS, CIAP_HIPERTENSAO];
  const linha = codigo === 'C4' ? 'DIABETES' : 'HIPERTENSAO';
  return cadastradas(ix.dados.pessoas, asOf).filter((p) => ix.condicoesAtivas(p.id, asOf).some((c) => c.lineOfCare === linha || condicaoBate(c, cids, ciaps)));
};
export const idosos = (ix: Indice, asOf: Date) => cadastradas(ix.dados.pessoas, asOf).filter((p) => idade(p, asOf) >= 60);
const pessoaPorId = (ix: Indice) => new Map(ix.dados.pessoas.map((p) => [p.id, p]));

// ───────────────────────────── apuração mensal ─────────────────────────────

function media(valores: { pontos: number; maximo: number }[], competencia: string, detalhe?: Record<string, { obtido: number; possivel: number }>): ResultadoMes {
  const n = valores.length;
  const soma = valores.reduce((s, v) => s + (v.maximo ? (v.pontos / v.maximo) * 100 : 0), 0);
  return { competencia, numerador: Math.round(soma * 100) / 100, denominador: n, valor: n ? Math.round((soma / n) * 100) / 100 : null, detalhe };
}

function detalhePraticas(codigo: CodigoIndicador, pontuacoes: Pontuacao[]): Record<string, { obtido: number; possivel: number }> {
  const d: Record<string, { obtido: number; possivel: number }> = {};
  for (const bp of praticas(codigo)) d[bp.letra] = { obtido: 0, possivel: 0 };
  for (const pt of pontuacoes) {
    for (const bp of pt.obtidas) {
      d[bp.letra]!.obtido++;
      d[bp.letra]!.possivel++;
    }
    for (const bp of pt.faltam) d[bp.letra]!.possivel++;
  }
  return d;
}

const razao = (competencia: string, numerador: number, denominador: number, fator = 100): ResultadoMes => ({
  competencia,
  numerador,
  denominador,
  valor: denominador ? Math.round((numerador / denominador) * fator * 100) / 100 : null,
});

/** Resultado de um indicador no mês para a equipe (null quando não há população ou fonte). */
export function apurarMes(codigo: CodigoIndicador, dados: DadosEquipe, mes: Mes): ResultadoMes {
  const ix = new Indice(dados);
  const eAp = dados.team.typeCode === '76';
  const { competencia, inicio, asOf, asOfLocal } = mes;
  const pessoas = cadastradas(dados.pessoas, asOf);
  switch (codigo) {
    case 'C1': {
      const atend = dados.consultas.filter((c) => (c.kind === 'SOAP' || c.kind === 'EVOLUCAO') && dados.membros.has(c.authorId) && CBO_C1.includes(c.cbo) && entre(c.at, inicio, asOf));
      return razao(competencia, atend.filter((c) => c.programada).length, atend.length);
    }
    case 'C2': {
      // Crianças que completaram dois anos no mês (cohorte cujo acompanhamento se encerrou).
      const coorte = pessoas.filter((p) => {
        const aniversario = segundoAniversario(p.birthDate);
        return aniversario.slice(0, 7) === competencia && aniversario <= asOfLocal;
      });
      const pts = coorte.map((p) => pontuarCrianca(ix, p, asOf, eAp));
      return media(pts, competencia, detalhePraticas('C2', pts));
    }
    case 'C3': {
      const vinculadas = new Map(pessoas.map((p) => [p.id, p]));
      const coorte = gestacoes(ix).filter((g) => vinculadas.has(g.patientId) && dataIso(g.fimPuerperio).slice(0, 7) === competencia && dataIso(g.fimPuerperio) <= asOfLocal);
      const pts = coorte.map((g) => pontuarGestacao(ix, g, asOf, eAp));
      return media(pts, competencia, detalhePraticas('C3', pts));
    }
    case 'C4':
    case 'C5': {
      const pts = cronicos(ix, codigo, asOf).map((p) => pontuarCronico(codigo, ix, p, asOf, eAp));
      return media(pts, competencia, detalhePraticas(codigo, pts));
    }
    case 'C6': {
      const pts = idosos(ix, asOf).map((p) => pontuarIdoso(ix, p, asOf, eAp));
      return media(pts, competencia, detalhePraticas('C6', pts));
    }
    case 'C7': {
      const detalhe: Record<string, { obtido: number; possivel: number }> = {};
      let valor = 0;
      let algum = false;
      for (const bp of praticas('C7')) {
        const grupo = pessoas.filter((p) => praticasC7Aplicaveis(p, asOf).some((b) => b.letra === bp.letra));
        const obtido = grupo.filter((p) => cumpreC7(ix, p, bp, asOf)).length;
        detalhe[bp.letra] = { obtido, possivel: grupo.length };
        if (grupo.length) {
          algum = true;
          valor += (obtido / grupo.length) * bp.pontos;
        }
      }
      const avaliadas = pessoas.filter((p) => praticasC7Aplicaveis(p, asOf).length > 0).length;
      return { competencia, numerador: Math.round(valor * 100) / 100, denominador: avaliadas, valor: algum ? Math.round(valor * 100) / 100 : null, detalhe };
    }
    case 'B1': {
      const primeiras = primeirasConsultasOdonto(dados, inicio, asOf);
      return razao(competencia, primeiras.size, dados.referencia.total);
    }
    case 'B2': {
      const primeiras = primeirasConsultasOdonto(dados, inicio, asOf);
      const concluidos = new Set(dados.consultas.filter((c) => c.kind === 'ODONTOGRAMA' && dados.membros.has(c.authorId) && c.conduta === 'TRATAMENTO_CONCLUIDO' && entre(c.at, inicio, asOf)).map((c) => c.patientId));
      return razao(competencia, concluidos.size, primeiras.size);
    }
    case 'B3':
    case 'B5':
    case 'B6': {
      const soma = (codes: readonly string[], cboFiltro: (cbo: string) => boolean) =>
        dados.procedimentos.filter((p) => dados.membros.has(p.professionalId) && cboFiltro(p.cbo) && codes.includes(p.code) && entre(p.at, inicio, asOf)).reduce((s, p) => s + p.quantity, 0);
      if (codigo === 'B3')
        return razao(
          competencia,
          soma(SIGTAP_APS.EXODONTIAS, (c) => c.startsWith(CBO_DENTISTA_PREFIXO)),
          soma(SIGTAP_APS.ODONTO_INDIVIDUAIS, ehSaudeBucal),
        );
      if (codigo === 'B5') return razao(competencia, soma(SIGTAP_APS.ODONTO_PREVENTIVOS, ehSaudeBucal), soma(SIGTAP_APS.ODONTO_INDIVIDUAIS, ehSaudeBucal));
      return razao(competencia, soma([SIGTAP_APS.ART], ehSaudeBucal), soma(SIGTAP_APS.ODONTO_RESTAURADORES, ehSaudeBucal));
    }
    case 'B4': {
      const criancas = new Set(
        dados.procedimentos.filter((p) => p.patientId && dados.membros.has(p.professionalId) && p.code === SIGTAP_APS.ESCOVACAO_SUPERVISIONADA && entre(p.at, inicio, asOf)).map((p) => p.patientId as string),
      );
      return razao(competencia, criancas.size, dados.referencia.criancas6a12);
    }
    case 'M1': {
      const acoes = dados.consultas.filter((c) => (c.kind === 'SOAP' || c.kind === 'EVOLUCAO') && dados.membros.has(c.authorId) && entre(c.at, addMeses(asOf, -4), asOf));
      return razao(competencia, acoes.length, new Set(acoes.map((a) => a.patientId)).size, 1);
    }
    case 'M2': {
      const acoes = dados.consultas.filter((c) => dados.membros.has(c.authorId) && entre(c.at, addMeses(asOf, -4), asOf));
      const compartilhadas = acoes.filter((c) => {
        const autores = dados.coautores.get(c.encounterId);
        return !!autores && [...autores].some((a) => a !== c.authorId);
      });
      return razao(competencia, compartilhadas.length, acoes.length);
    }
    default:
      return { competencia, valor: null, numerador: 0, denominador: 0 };
  }
}

/** Pessoas com primeira consulta odontológica programada no mês pelos dentistas da equipe (uma por dentista a cada 12 meses). */
function primeirasConsultasOdonto(dados: DadosEquipe, inicio: Date, asOf: Date): Set<string> {
  const eventos = dados.procedimentos.filter((p) => p.patientId && dados.membros.has(p.professionalId) && p.cbo.startsWith(CBO_DENTISTA_PREFIXO) && p.code === SIGTAP_APS.PRIMEIRA_CONSULTA_ODONTO);
  const concluidos = dados.consultas.filter((c) => c.kind === 'ODONTOGRAMA' && c.conduta === 'TRATAMENTO_CONCLUIDO');
  const pessoas = new Set<string>();
  for (const ev of eventos) {
    if (!entre(ev.at, inicio, asOf)) continue;
    const pid = ev.patientId as string;
    const janela = addDias(ev.at, -365);
    const repetida =
      eventos.some((o) => o !== ev && o.patientId === pid && o.professionalId === ev.professionalId && o.at.getTime() >= janela.getTime() && o.at.getTime() < ev.at.getTime()) ||
      concluidos.some((c) => c.patientId === pid && c.authorId === ev.professionalId && c.at.getTime() >= janela.getTime() && c.at.getTime() < ev.at.getTime());
    if (!repetida) pessoas.add(pid);
  }
  return pessoas;
}

// ───────────────────────────── lista nominal ─────────────────────────────

const faltamDe = (pt: Pontuacao) => pt.faltam.map((bp) => ({ letra: bp.letra, descricao: bp.descricao, pontos: bp.pontos }));

/** Quem está em acompanhamento na data e o que falta para pontuar. */
export function pendencias(codigo: CodigoIndicador, dados: DadosEquipe, asOf: Date, asOfLocal = dataIso(asOf)): Pendencia[] {
  const ix = new Indice(dados);
  const eAp = dados.team.typeCode === '76';
  const out: Pendencia[] = [];
  switch (codigo) {
    case 'C2': {
      for (const p of cadastradas(dados.pessoas, asOf)) {
        const n = p.birthDate;
        if (dataIso(n) > asOfLocal || segundoAniversario(n) < asOfLocal) continue;
        const pt = pontuarCrianca(ix, p, asOf, eAp);
        out.push({ ...nomeIdade(p, asOf), pontos: pt.pontos, maximo: pt.maximo, faltam: faltamDe(pt), observacao: `${Math.floor((asOf.getTime() - n.getTime()) / MES)} meses de vida` });
      }
      break;
    }
    case 'C3': {
      const pessoas = pessoaPorId(ix);
      for (const g of gestacoes(ix)) {
        const p = pessoas.get(g.patientId);
        if (!p || dataIso(g.dum) > asOfLocal || dataIso(g.fimPuerperio) < asOfLocal) continue;
        const pt = pontuarGestacao(ix, g, asOf, eAp);
        const semanas = Math.floor((asOf.getTime() - g.dum.getTime()) / (7 * DIA));
        const fase = asOf.getTime() > g.fimGestacao.getTime() ? 'puerpério' : `${semanas} semanas de gestação`;
        out.push({ ...nomeIdade(p, asOf), pontos: pt.pontos, maximo: pt.maximo, faltam: faltamDe(pt), observacao: g.desfechoRegistrado ? fase : `${fase} (sem desfecho registrado)` });
      }
      break;
    }
    case 'C4':
    case 'C5': {
      for (const p of cronicos(ix, codigo, asOf)) {
        const pt = pontuarCronico(codigo, ix, p, asOf, eAp);
        out.push({ ...nomeIdade(p, asOf), pontos: pt.pontos, maximo: pt.maximo, faltam: faltamDe(pt) });
      }
      break;
    }
    case 'C6': {
      for (const p of idosos(ix, asOf)) {
        const pt = pontuarIdoso(ix, p, asOf, eAp);
        out.push({ ...nomeIdade(p, asOf), pontos: pt.pontos, maximo: pt.maximo, faltam: faltamDe(pt) });
      }
      break;
    }
    case 'C7': {
      for (const p of cadastradas(dados.pessoas, asOf)) {
        const aplicaveis = praticasC7Aplicaveis(p, asOf);
        if (!aplicaveis.length) continue;
        const pt = pontuar(aplicaveis, (bp) => cumpreC7(ix, p, bp, asOf), eAp);
        out.push({ ...nomeIdade(p, asOf), pontos: pt.pontos, maximo: pt.maximo, faltam: faltamDe(pt) });
      }
      break;
    }
    default:
      return [];
  }
  return out.filter((p) => p.faltam.length > 0).sort((a, b) => a.pontos / a.maximo - b.pontos / b.maximo || a.nome.localeCompare(b.nome, 'pt-BR'));
}
