import { createHash } from 'node:crypto';
import { normalizarNomePessoa, type RegistroOficialNormalizado, type SistemaOficial, type TipoArquivoOficial, type TipoRegistroOficial } from '@omnisaude/shared';
import { gravidadeDoRegistro, situacaoDoRegistro } from './normalizar';

/**
 * Mescla por campo do registro oficial (VIG-1c, frente F2). Um valor não vazio sobrescreve; um valor vazio só apaga o
 * campo se o mesmo tipo de arquivo o tinha gravado (`data._fontes`: campo → tipo de arquivo). Assim o NINDINET não
 * apaga a classificação que veio do DBF do agravo, e uma exportação sem identificação não apaga o nome.
 */

/** Campos do registro que vão para colunas próprias de official_records. */
export const CAMPOS = [
  'numero',
  'notificadoEm',
  'semanaNotificacao',
  'municipioNotificacao',
  'cnes',
  'agravo',
  'tipoSuspeita',
  'grupo',
  'inicioSintomas',
  'semanaSintomas',
  'municipioResidencia',
  'bairroCodigo',
  'bairroNome',
  'classificacao',
  'criterio',
  'evolucao',
  'encerradoEm',
  'obitoEm',
  'excluido',
  'nome',
  'nascimento',
  'sexo',
  'mae',
  'cns',
  'cpf',
] as const;
export type Campo = (typeof CAMPOS)[number];
type Valor = string | number | boolean | null;

/** Campos que identificam o paciente (fora da prévia de quem não pode ver o grupo sigiloso). */
export const CAMPOS_IDENTIFICACAO: readonly Campo[] = ['nome', 'nascimento', 'sexo', 'mae', 'cns', 'cpf'];

export interface EstadoRegistro {
  valores: Partial<Record<Campo, string | boolean | null>>;
  extras: Record<string, Valor>;
  /** Campo (ou "extras.x") → tipo de arquivo que gravou o valor. */
  fontes: Record<string, TipoArquivoOficial>;
}

export const estadoVazio = (): EstadoRegistro => ({ valores: {}, extras: {}, fontes: {} });

/** Valor do campo na parte (o nome da mãe vai normalizado: o banco só guarda a forma de comparação). */
function valorDaParte(p: RegistroOficialNormalizado, campo: string): Valor {
  if (campo.startsWith('extras.')) return p.extras[campo.slice(7)] ?? null;
  const id = p.identificacao;
  switch (campo as Campo) {
    case 'nome':
      return id?.nome ?? null;
    case 'nascimento':
      return id?.nascimento ?? null;
    case 'sexo':
      return id?.sexo ?? null;
    case 'mae':
      return normalizarNomePessoa(id?.mae) || null;
    case 'cns':
      return id?.cns ?? null;
    case 'cpf':
      return id?.cpf ?? null;
    case 'numero':
      return p.numero;
    case 'notificadoEm':
      return p.notificadoEm;
    case 'semanaNotificacao':
      return p.semanaNotificacao;
    case 'municipioNotificacao':
      return p.municipioNotificacao;
    case 'cnes':
      return p.cnes;
    case 'agravo':
      return p.agravo;
    case 'tipoSuspeita':
      return p.tipoSuspeita;
    case 'grupo':
      return p.grupo;
    case 'inicioSintomas':
      return p.inicioSintomas;
    case 'semanaSintomas':
      return p.semanaSintomas;
    case 'municipioResidencia':
      return p.municipioResidencia;
    case 'bairroCodigo':
      return p.bairroCodigo;
    case 'bairroNome':
      return p.bairroNome;
    case 'classificacao':
      return p.classificacao;
    case 'criterio':
      return p.criterio;
    case 'evolucao':
      return p.evolucao;
    case 'encerradoEm':
      return p.encerradoEm;
    case 'obitoEm':
      return p.obitoEm;
    case 'excluido':
      return p.excluido;
    default:
      return null;
  }
}

const vazio = (v: Valor | undefined) => v === null || v === undefined || v === '';

/** Aplica uma parte (um arquivo) sobre o estado, campo a campo. Não altera o estado recebido. */
export function aplicarParte(estado: EstadoRegistro, parte: RegistroOficialNormalizado): EstadoRegistro {
  const novo: EstadoRegistro = { valores: { ...estado.valores }, extras: { ...estado.extras }, fontes: { ...estado.fontes } };
  const tipo = parte.tipoArquivo;
  // Os campos da chave natural vêm sempre (sem eles não haveria registro).
  for (const campo of new Set(['numero', 'notificadoEm', ...parte.colunas])) {
    const v = valorDaParte(parte, campo);
    const extra = campo.startsWith('extras.');
    if (!vazio(v)) {
      if (extra) novo.extras[campo.slice(7)] = v;
      else novo.valores[campo as Campo] = v as string | boolean;
      novo.fontes[campo] = tipo;
    } else if (novo.fontes[campo] === tipo) {
      if (extra) delete novo.extras[campo.slice(7)];
      else delete novo.valores[campo as Campo];
      delete novo.fontes[campo];
    }
  }
  return novo;
}

/** Hash do conteúdo (só os valores; a origem de cada campo não conta como mudança). */
export function hashDoEstado(sistema: SistemaOficial, tipo: TipoRegistroOficial, e: EstadoRegistro): string {
  const extras = Object.keys(e.extras)
    .sort()
    .filter((k) => !vazio(e.extras[k]))
    .map((k) => [k, e.extras[k]]);
  const corpo = JSON.stringify([sistema, tipo, CAMPOS.map((c) => (vazio(e.valores[c]) ? null : e.valores[c])), extras]);
  return createHash('sha256').update(corpo).digest('hex');
}

/** Mesma origem em todos os campos (sem isso, o registro igual ainda precisa gravar `_fontes`). */
export function mesmasFontes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Diferenças entre dois estados (para a prévia dos alterados). */
export function diferencas(antes: EstadoRegistro, depois: EstadoRegistro): { campo: string; antes: string | null; depois: string | null }[] {
  const out: { campo: string; antes: string | null; depois: string | null }[] = [];
  const txt = (v: Valor | undefined) => (vazio(v) ? null : String(v));
  for (const c of CAMPOS) if (txt(antes.valores[c]) !== txt(depois.valores[c])) out.push({ campo: c, antes: txt(antes.valores[c]), depois: txt(depois.valores[c]) });
  for (const k of new Set([...Object.keys(antes.extras), ...Object.keys(depois.extras)]))
    if (txt(antes.extras[k]) !== txt(depois.extras[k])) out.push({ campo: `extras.${k}`, antes: txt(antes.extras[k]), depois: txt(depois.extras[k]) });
  return out;
}

// ───────────── banco ─────────────

/** Colunas de official_records lidas para refazer o estado. */
export const SELECT_ESTADO = {
  id: true,
  system: true,
  type: true,
  naturalKey: true,
  number: true,
  notifiedOn: true,
  epiWeekNotified: true,
  municipalityIbge: true,
  unitCnes: true,
  agravo: true,
  suspectedType: true,
  groupKey: true,
  symptomsOnset: true,
  epiWeekOnset: true,
  residenceIbge: true,
  neighborhoodCode: true,
  neighborhoodName: true,
  finalClass: true,
  criterion: true,
  evolution: true,
  closedOn: true,
  deathOn: true,
  excluded: true,
  patientName: true,
  birthDate: true,
  sex: true,
  motherNameNorm: true,
  cns: true,
  cpf: true,
  data: true,
  contentHash: true,
  absentSince: true,
  notificationId: true,
} as const;

export interface LinhaEstado {
  id: string;
  number: string;
  notifiedOn: Date;
  epiWeekNotified: string | null;
  municipalityIbge: string | null;
  unitCnes: string | null;
  agravo: string | null;
  suspectedType: string | null;
  groupKey: string | null;
  symptomsOnset: Date | null;
  epiWeekOnset: string | null;
  residenceIbge: string | null;
  neighborhoodCode: string | null;
  neighborhoodName: string | null;
  finalClass: string | null;
  criterion: string | null;
  evolution: string | null;
  closedOn: Date | null;
  deathOn: Date | null;
  excluded: boolean;
  patientName: string | null;
  birthDate: Date | null;
  sex: string | null;
  motherNameNorm: string | null;
  cns: string | null;
  cpf: string | null;
  data: unknown;
}

const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const data = (s: string | boolean | null | undefined) => (typeof s === 'string' && s ? new Date(`${s}T00:00:00Z`) : null);
const txt = (s: string | boolean | null | undefined) => (typeof s === 'string' && s ? s : null);

/** Estado a partir da linha do banco (o mesmo formato que a mescla produz). */
export function estadoDoBanco(r: LinhaEstado): EstadoRegistro {
  const dados = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
  const { _fontes, ...extras } = dados;
  const fontes = (_fontes && typeof _fontes === 'object' ? _fontes : {}) as Record<string, TipoArquivoOficial>;
  const valores: EstadoRegistro['valores'] = {
    numero: r.number,
    notificadoEm: dia(r.notifiedOn),
    semanaNotificacao: r.epiWeekNotified?.trim() || null,
    municipioNotificacao: r.municipalityIbge,
    cnes: r.unitCnes,
    agravo: r.agravo,
    tipoSuspeita: r.suspectedType,
    grupo: r.groupKey,
    inicioSintomas: dia(r.symptomsOnset),
    semanaSintomas: r.epiWeekOnset?.trim() || null,
    municipioResidencia: r.residenceIbge,
    bairroCodigo: r.neighborhoodCode,
    bairroNome: r.neighborhoodName,
    classificacao: r.finalClass,
    criterio: r.criterion,
    evolucao: r.evolution,
    encerradoEm: dia(r.closedOn),
    obitoEm: dia(r.deathOn),
    // A coluna é NOT NULL: "falso" só existe no estado se algum arquivo o gravou (senão o hash mudaria sozinho).
    excluido: r.excluded ? true : fontes.excluido ? false : undefined,
    nome: r.patientName,
    nascimento: dia(r.birthDate),
    sexo: r.sex?.trim() || null,
    mae: r.motherNameNorm,
    cns: r.cns,
    cpf: r.cpf,
  };
  for (const c of CAMPOS) if (vazio(valores[c])) delete valores[c];
  return { valores, extras: extras as Record<string, Valor>, fontes };
}

/** Colunas de official_records a partir do estado (com os derivados: situação, gravidade, sigilo e nome normalizado). */
export function colunasDoEstado(sistema: SistemaOficial, e: EstadoRegistro, sensiveis: ReadonlySet<string>) {
  const v = e.valores;
  const agravo = txt(v.agravo);
  const classificacao = txt(v.classificacao);
  const grupo = txt(v.grupo);
  return {
    number: txt(v.numero) ?? '',
    notifiedOn: data(v.notificadoEm)!,
    epiWeekNotified: txt(v.semanaNotificacao),
    municipalityIbge: txt(v.municipioNotificacao),
    unitCnes: txt(v.cnes),
    agravo,
    suspectedType: txt(v.tipoSuspeita),
    groupKey: grupo,
    symptomsOnset: data(v.inicioSintomas),
    epiWeekOnset: txt(v.semanaSintomas),
    residenceIbge: txt(v.municipioResidencia),
    neighborhoodCode: txt(v.bairroCodigo),
    neighborhoodName: txt(v.bairroNome),
    finalClass: classificacao,
    criterion: txt(v.criterio),
    evolution: txt(v.evolucao),
    closedOn: data(v.encerradoEm),
    deathOn: data(v.obitoEm),
    situation: situacaoDoRegistro(sistema, agravo, classificacao, txt(v.criterio)),
    severity: gravidadeDoRegistro(sistema, agravo, classificacao),
    excluded: v.excluido === true,
    sensitive: !!grupo && sensiveis.has(grupo),
    patientName: txt(v.nome),
    patientNameNorm: normalizarNomePessoa(txt(v.nome)) || null,
    birthDate: data(v.nascimento),
    sex: txt(v.sexo),
    motherNameNorm: txt(v.mae),
    cns: txt(v.cns),
    cpf: txt(v.cpf),
    data: { ...e.extras, _fontes: e.fontes },
  };
}

/** Quantos campos preenchidos (para escolher entre duas linhas com a mesma chave no mesmo arquivo). */
export function preenchidos(p: RegistroOficialNormalizado): number {
  let n = 0;
  for (const c of new Set(['numero', 'notificadoEm', ...p.colunas])) if (!vazio(valorDaParte(p, c))) n++;
  return n;
}
