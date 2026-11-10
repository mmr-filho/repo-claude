import {
  chaveNatural,
  gravidadeOficial,
  infoAgravoSinan,
  normalizarAgravo,
  normalizarNomePessoa,
  onlyDigits,
  semanaDaData,
  semanasNoAno,
  SISTEMA_DO_ARQUIVO,
  situacaoOficial,
  TIPO_REGISTRO_DO_ARQUIVO,
  type GravidadeCaso,
  type IdentificacaoRegistro,
  type RegistroOficialNormalizado,
  type SistemaOficial,
  type SituacaoCaso,
  type TipoArquivoOficial,
} from '@omnisaude/shared';
import type { LinhaArquivo } from './dbf';

/**
 * Normalização de uma linha de exportação oficial em `RegistroOficialNormalizado` (VIG-1c, frente F2). Armadilhas do
 * Sinan: SG_UF traz código IBGE; ID_MUNICIP com 7 dígitos compara pelos 6 primeiros; ano epidemiológico pelos 4
 * primeiros dígitos de SEM_NOT/SEM_PRI, nunca por NU_ANO; NU_IDADE_N = unidade + 3 dígitos. e-SUS: categorias pelo
 * texto, 'Cancelado' = excluído; datas dd/mm/aaaa, aaaa-mm-dd ou ISO; recusa datas antes do piso do sistema ou futuras.
 * Colunas de contato (telefone, e-mail, endereço, notificante) são descartadas.
 *
 * As colunas da linha chegam normalizadas (`normalizarCabecalho`): as do Sinan em minúsculas (nu_notific...), as do
 * e-SUS Notifica pelo rótulo ("numero da notificacao"...).
 */

export interface ContextoNormalizacao {
  tipo: TipoArquivoOficial;
  /** Nome do arquivo (para os avisos e as recusas). */
  arquivo: string;
  /** IBGE do município do tenant (7 dígitos). */
  municipio: string;
  /** Hoje, AAAA-MM-DD (datas futuras são recusadas). */
  hoje: string;
  /** Nome normalizado + UF → IBGE, quando o sistema tiver a tabela de municípios (e-SUS Notifica traz o nome). */
  municipiosPorNome?: Map<string, string>;
  /** Grupos sigilosos do catálogo (sem identificação para quem não tem `notificacao.sensivel`). */
  sensiveis?: ReadonlySet<string>;
  /** Grupo pelo CID quando o agravo não está na tabela do Sinan (de-para homologado do catálogo do tenant). */
  grupoDoCid?: (cid: string) => string | null;
}

export type ResultadoNormalizacao = { registro: RegistroOficialNormalizado; avisos: string[] } | { recusado: string };

// ───────────── datas ─────────────

export interface DataLida {
  data: string | null;
  invalida: boolean;
  /** Data ISO em UTC com hora de 13h ou mais: pode ter vindo de outro fuso (o dia pode estar um antes). */
  duvidosa: boolean;
}

const dataValida = (a: number, m: number, d: number) => {
  if (a < 1900 || a > 2999 || m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const iso = (a: number, m: number, d: number) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Data em AAAA-MM-DD, AAAAMMDD, dd/mm/aaaa (com ou sem hora) ou ISO 8601 (com Z: parte da data se a hora for de 0h a 12h). */
export function lerData(valor: string | null | undefined): DataLida {
  const s = (valor ?? '').trim();
  if (!s) return { data: null, invalida: false, duvidosa: false };
  let a: number;
  let m: number;
  let d: number;
  let duvidosa = false;
  let r: RegExpMatchArray | null;
  if ((r = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)) || (r = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  } else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/))) {
    [d, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
  } else if ((r = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i))) {
    [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
    const fuso = (r[6] ?? '').toUpperCase();
    if ((fuso === 'Z' || /^[+-]00:?00$/.test(fuso)) && Number(r[4]) > 12) duvidosa = true;
  } else {
    return { data: null, invalida: true, duvidosa: false };
  }
  if (!dataValida(a, m, d)) return { data: null, invalida: true, duvidosa: false };
  return { data: iso(a, m, d), invalida: false, duvidosa };
}

const dataBr = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** Piso da data da notificação por sistema (dicionários de dados: e-SUS Notifica depois de 01/01/2020; e-SUS Sinan, 01/01/2022). */
export const PISO_NOTIFICACAO: Partial<Record<SistemaOficial, string>> = { ESUS_NOTIFICA: '2020-01-01', ESUS_SINAN: '2022-01-01' };

// ───────────── auxiliares ─────────────

const texto = (l: LinhaArquivo, c: string): string | null => {
  const v = l[c];
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
};
const tem = (l: LinhaArquivo, c: string) => c in l;
/** Código sem zeros à esquerda ('05' vira '5'; '0' fica). */
const codigo = (v: string | null) => (v && /^\d+$/.test(v) ? String(Number(v)) : v);
const ibge = (v: string | null) => {
  const d = onlyDigits(v ?? '');
  return d.length === 6 || d.length === 7 ? d : null;
};
const cnesDe = (v: string | null) => {
  const d = onlyDigits(v ?? '');
  return d.length >= 1 && d.length <= 7 ? d.padStart(7, '0') : null;
};
const cnsDe = (v: string | null) => {
  const d = onlyDigits(v ?? '');
  return d.length === 15 ? d : null;
};
const cpfDe = (v: string | null) => {
  const d = onlyDigits(v ?? '');
  return d.length === 11 ? d : null;
};
const sexoDe = (v: string | null) => {
  const t = normalizarNomePessoa(v);
  if (!t) return null;
  if (t === 'm' || t.startsWith('masc')) return 'M';
  if (t === 'f' || t.startsWith('fem')) return 'F';
  if (t === 'i' || t.startsWith('indef') || t.startsWith('ign')) return 'I';
  return null;
};
/** Código de até 2 caracteres (CLASSI_FIN, CRITERIO, EVOLUCAO, CS_SUSPEIT); mais longo fica vazio, com aviso. */
const curto = (v: string | null, coluna: string, avisos: string[]) => {
  if (v && v.length > 2) {
    avisos.push(`${coluna} fora do formato (mais de 2 caracteres)`);
    return null;
  }
  return v;
};
/** Semana AAAASS quando é uma semana que existe; senão null. */
const semanaValida = (v: string | null) => {
  if (!v || !/^\d{6}$/.test(v)) return null;
  const ano = Number(v.slice(0, 4));
  const se = Number(v.slice(4));
  return ano >= 1900 && se >= 1 && se <= semanasNoAno(ano) ? v : null;
};

/** Situação do registro: no e-SUS Notifica pela classificação de lá (1 a 4 confirmado, 5 SG não especificada, 6 descartado). */
export function situacaoDoRegistro(sistema: SistemaOficial, agravo: string | null, classificacao: string | null, criterio: string | null): SituacaoCaso {
  if (sistema === 'ESUS_NOTIFICA') {
    if (!classificacao) return 'EM_INVESTIGACAO';
    if (['1', '2', '3', '4'].includes(classificacao)) return 'CONFIRMADO';
    if (classificacao === '5') return 'INCONCLUSIVO';
    if (classificacao === '6') return 'DESCARTADO';
    return 'EM_INVESTIGACAO';
  }
  return situacaoOficial(agravo, classificacao, criterio);
}

export function gravidadeDoRegistro(sistema: SistemaOficial, agravo: string | null, classificacao: string | null): GravidadeCaso | null {
  return sistema === 'ESUS_NOTIFICA' ? null : gravidadeOficial(agravo, classificacao);
}

/** Grupo do catálogo pelo agravo: tabela do Sinan e, sem ela, o de-para de CID do tenant. */
export function grupoDoAgravo(agravo: string | null, ctx: Pick<ContextoNormalizacao, 'grupoDoCid'>): string | null {
  if (!agravo) return null;
  return infoAgravoSinan(agravo)?.grupo ?? ctx.grupoDoCid?.(agravo) ?? null;
}

// ───────────── Sinan Net, Sinan Online e e-SUS Sinan ─────────────

/** Variáveis do Sinan guardadas em `extras` (o resto da ficha de investigação fica de fora). */
const EXTRAS_SINAN = [
  'tp_not',
  'nu_ano',
  'sg_uf_not',
  'id_regiona',
  'sg_uf',
  'id_rg_resi',
  'id_distrit',
  'cs_gestant',
  'cs_raca',
  'cs_escol_n',
  'nu_idade_n',
  'ano_nasc',
  'cs_zona',
  'id_pais',
  'nduplic_n',
  'in_vincula',
  'tp_sistema',
  'tpautocto',
  'coufinf',
  'copaisinf',
  'comuninf',
  'codisinf',
  'co_bainfc',
  'nobaiinf',
  'doenca_tra',
  'clinc_chik',
  'id_ocupa_n',
  'status',
  'no_agravo',
  // Surto (NSURTNET): casos, local inicial, município de ocorrência, transmissão, veículo e delimitação.
  'qt_total_c',
  'cs_local',
  'nm_local',
  'cs_trans',
  'tp_indiret',
  'cs_veiculo',
  'delimita',
  'deli_outro',
];
/** Datas do Sinan guardadas em `extras` (em AAAA-MM-DD). */
const EXTRAS_DATA_SINAN = ['dt_invest', 'dt_digita'];
/** Variáveis de identificação do paciente no Sinan e no e-SUS Sinan. */
const IDENTIFICACAO_SINAN = ['nm_pacient', 'dt_nasc', 'cs_sexo', 'nm_mae_pac', 'id_cns_sus', 'cpf', 'nu_cpf'];
const UNIDADE_IDADE: Record<string, string> = { '1': 'hora', '2': 'dia', '3': 'mês', '4': 'ano' };

function normalizarSinan(l: LinhaArquivo, ctx: ContextoNormalizacao): ResultadoNormalizacao {
  const tipoArq = ctx.tipo;
  const sistema = SISTEMA_DO_ARQUIVO[tipoArq]!;
  const tipo = TIPO_REGISTRO_DO_ARQUIVO[tipoArq]!;
  const avisos: string[] = [];
  const colunas: string[] = [];
  const c = (campo: string, ...origens: string[]) => {
    if (origens.some((o) => tem(l, o))) colunas.push(campo);
  };

  const numero = (texto(l, 'nu_notific') ?? '').replace(/\s+/g, '');
  if (!numero) return { recusado: 'Sem número da notificação (NU_NOTIFIC)' };
  if (numero.length > 20) return { recusado: 'Número da notificação com mais de 20 caracteres' };
  const dn = lerData(texto(l, 'dt_notific'));
  if (!dn.data) return { recusado: dn.invalida ? 'Data da notificação inválida' : 'Sem data da notificação (DT_NOTIFIC)' };
  if (dn.data > ctx.hoje) return { recusado: 'Data da notificação no futuro' };
  const piso = PISO_NOTIFICACAO[sistema];
  if (piso && dn.data < piso) return { recusado: `Data da notificação anterior a ${dataBr(piso)} (início do sistema)` };

  const agravo = tipo === 'NEGATIVA' ? null : normalizarAgravo(texto(l, 'id_agravo'), tipoArq);
  if (tipo === 'INDIVIDUAL' && !agravo) return { recusado: 'Sem agravo (ID_AGRAVO)' };
  if (agravo && !/^[A-Z0-9]{2,8}$/.test(agravo)) return { recusado: 'Código do agravo inválido (ID_AGRAVO)' };
  const municipioNotificacao = ibge(texto(l, 'id_municip'));
  const cnes = cnesDe(texto(l, 'id_unidade'));
  if (tipo === 'NEGATIVA' && !cnes) return { recusado: 'Negativa sem unidade de saúde (ID_UNIDADE)' };
  const grupo = grupoDoAgravo(agravo, ctx);

  const semanaNotificacao = semanaValida(texto(l, 'sem_not')) ?? semanaDaData(dn.data).codigo;
  const ds = lerData(texto(l, 'dt_sin_pri') ?? texto(l, 'dt_prim_si'));
  if (ds.invalida) avisos.push('Data dos primeiros sintomas inválida');
  const inicioSintomas = ds.data;
  const semanaSintomas = semanaValida(texto(l, 'sem_pri')) ?? (inicioSintomas ? semanaDaData(inicioSintomas).codigo : null);
  const de = lerData(texto(l, 'dt_encerra') ?? texto(l, 'dt_conclu'));
  if (de.invalida) avisos.push('Data do encerramento inválida');
  const dob = lerData(texto(l, 'dt_obito'));
  if (dob.invalida) avisos.push('Data do óbito inválida');
  // Classificação, critério e evolução só na notificação individual (no surto, CLASSI_FIN e CRITERIO são dos casos
  // da planilha, com outra numeração; a negativa não tem).
  const individual = tipo === 'INDIVIDUAL';
  const classificacao = individual ? curto(codigo(texto(l, 'classi_fin')), 'CLASSI_FIN', avisos) : null;
  const criterio = individual ? curto(codigo(texto(l, 'criterio')), 'CRITERIO', avisos) : null;
  const evolucao = individual ? curto(codigo(texto(l, 'evolucao')), 'EVOLUCAO', avisos) : null;
  // Excluído: NDUPLIC_N 2 (duplicidade, "não contar") ou STATUS "Excluída" do e-SUS Sinan.
  const status = normalizarNomePessoa(texto(l, 'status'));
  const excluido = texto(l, 'nduplic_n') === '2' || status.startsWith('excluid');

  c('numero', 'nu_notific');
  c('notificadoEm', 'dt_notific');
  colunas.push('semanaNotificacao');
  c('municipioNotificacao', 'id_municip');
  c('cnes', 'id_unidade');
  if (tipo !== 'NEGATIVA') c('agravo', 'id_agravo');
  if (tipo !== 'NEGATIVA') c('grupo', 'id_agravo');
  c('tipoSuspeita', 'cs_suspeit');
  c('inicioSintomas', 'dt_sin_pri', 'dt_prim_si');
  c('semanaSintomas', 'sem_pri', 'dt_sin_pri', 'dt_prim_si');
  c('municipioResidencia', 'id_mn_resi', 'id_muni_re');
  c('bairroCodigo', 'id_bairro');
  c('bairroNome', 'nm_bairro');
  if (individual) {
    c('classificacao', 'classi_fin');
    c('criterio', 'criterio');
    c('evolucao', 'evolucao');
  }
  c('encerradoEm', 'dt_encerra', 'dt_conclu');
  c('obitoEm', 'dt_obito');
  c('excluido', 'nduplic_n', 'status');

  let identificacao: IdentificacaoRegistro | null = null;
  if (IDENTIFICACAO_SINAN.some((x) => tem(l, x))) {
    const dnasc = lerData(texto(l, 'dt_nasc'));
    identificacao = {
      nome: texto(l, 'nm_pacient'),
      nascimento: dnasc.data,
      sexo: sexoDe(texto(l, 'cs_sexo')),
      mae: texto(l, 'nm_mae_pac'),
      cns: cnsDe(texto(l, 'id_cns_sus')),
      cpf: cpfDe(texto(l, 'cpf') ?? texto(l, 'nu_cpf')),
    };
    c('nome', 'nm_pacient');
    c('nascimento', 'dt_nasc');
    c('sexo', 'cs_sexo');
    c('mae', 'nm_mae_pac');
    c('cns', 'id_cns_sus');
    c('cpf', 'cpf', 'nu_cpf');
  }

  const extras: RegistroOficialNormalizado['extras'] = {};
  for (const x of EXTRAS_SINAN) {
    if (!tem(l, x)) continue;
    extras[x] = texto(l, x);
    colunas.push(`extras.${x}`);
  }
  for (const x of EXTRAS_DATA_SINAN) {
    if (!tem(l, x)) continue;
    extras[x] = lerData(texto(l, x)).data;
    colunas.push(`extras.${x}`);
  }
  const idade = texto(l, 'nu_idade_n');
  if (idade && /^[1-4]\d{3}$/.test(idade)) {
    extras.idade = `${Number(idade.slice(1))} ${UNIDADE_IDADE[idade[0]!]}`;
    colunas.push('extras.idade');
  } else if (tem(l, 'nu_idade_n')) {
    extras.idade = null;
    colunas.push('extras.idade');
  }

  const registro: RegistroOficialNormalizado = {
    chave: chaveNatural({ sistema, tipo, numero, notificadoEm: dn.data, municipio: municipioNotificacao, agravo, cnes }),
    sistema,
    tipo,
    tipoArquivo: tipoArq,
    numero,
    notificadoEm: dn.data,
    semanaNotificacao,
    municipioNotificacao,
    cnes,
    agravo,
    tipoSuspeita: curto(texto(l, 'cs_suspeit'), 'CS_SUSPEIT', avisos),
    grupo,
    inicioSintomas,
    semanaSintomas,
    municipioResidencia: ibge(texto(l, 'id_mn_resi') ?? texto(l, 'id_muni_re')),
    bairroCodigo: texto(l, 'id_bairro')?.slice(0, 20) ?? null,
    bairroNome: texto(l, 'nm_bairro'),
    classificacao,
    criterio,
    evolucao,
    encerradoEm: de.data,
    obitoEm: dob.data,
    situacao: situacaoDoRegistro(sistema, agravo, classificacao, criterio),
    gravidade: gravidadeDoRegistro(sistema, agravo, classificacao),
    excluido,
    sigiloso: !!grupo && !!ctx.sensiveis?.has(grupo),
    identificacao,
    extras,
    colunas,
  };
  return { registro, avisos };
}

// ───────────── e-SUS Notifica ─────────────

/** UF pelo nome, pela sigla ou pelo código IBGE (o CSV do e-SUS Notifica traz o nome do estado). */
const UFS: { sigla: string; ibge: string; nome: string }[] = [
  ['AC', '12', 'acre'],
  ['AL', '27', 'alagoas'],
  ['AP', '16', 'amapa'],
  ['AM', '13', 'amazonas'],
  ['BA', '29', 'bahia'],
  ['CE', '23', 'ceara'],
  ['DF', '53', 'distrito federal'],
  ['ES', '32', 'espirito santo'],
  ['GO', '52', 'goias'],
  ['MA', '21', 'maranhao'],
  ['MT', '51', 'mato grosso'],
  ['MS', '50', 'mato grosso do sul'],
  ['MG', '31', 'minas gerais'],
  ['PA', '15', 'para'],
  ['PB', '25', 'paraiba'],
  ['PR', '41', 'parana'],
  ['PE', '26', 'pernambuco'],
  ['PI', '22', 'piaui'],
  ['RJ', '33', 'rio de janeiro'],
  ['RN', '24', 'rio grande do norte'],
  ['RS', '43', 'rio grande do sul'],
  ['RO', '11', 'rondonia'],
  ['RR', '14', 'roraima'],
  ['SC', '42', 'santa catarina'],
  ['SP', '35', 'sao paulo'],
  ['SE', '28', 'sergipe'],
  ['TO', '17', 'tocantins'],
].map(([sigla, ibge, nome]) => ({ sigla: sigla!, ibge: ibge!, nome: nome! }));

export function siglaDaUf(v: string | null | undefined): string | null {
  const t = normalizarNomePessoa(v);
  if (!t) return onlyDigits(v ?? '').length === 2 ? (UFS.find((u) => u.ibge === onlyDigits(v ?? ''))?.sigla ?? null) : null;
  return UFS.find((u) => u.sigla.toLowerCase() === t || u.nome === t)?.sigla ?? null;
}

/** Chave da tabela de municípios por nome: nome normalizado + UF. */
export const chaveMunicipio = (nome: string, uf: string) => `${normalizarNomePessoa(nome)}|${uf.toUpperCase()}`;

/** Classificação final do e-SUS Notifica pelo texto (a numeração muda entre a exportação e a API). */
const CLASSIFICACAO_ESUS: Record<string, string> = {
  'confirmado laboratorial': '1',
  'confirmacao laboratorial': '1',
  'confirmado clinico epidemiologico': '2',
  'confirmado clinico imagem': '3',
  'confirmado por criterio clinico': '4',
  'confirmado criterio clinico': '4',
  'confirmado clinico': '4',
  'sindrome gripal nao especificada': '5',
  descartado: '6',
};
/** Evolução do caso do e-SUS Notifica pelo texto ('Cancelado' = ficha excluída). */
const EVOLUCAO_ESUS: Record<string, string> = {
  cura: '1',
  obito: '2',
  'em tratamento domiciliar': '3',
  internado: '4',
  'internado em uti': '5',
  ignorado: '6',
  cancelado: '7',
};
/** Colunas que marcam a ficha de síndrome gripal (o resto do e-SUS Notifica não tem agravo identificado aqui). */
const MARCAS_SG = ['sintoma', 'estado do teste', 'resultado rtpcr', 'tipo de teste'];
/** Colunas do e-SUS Notifica guardadas em `extras` (sem contato: telefone, e-mail, endereço e notificante ficam fora). */
const EXTRAS_ESUS = ['estado da notificacao', 'estado de residencia', 'raca cor', 'e profissional de saude', 'classificacao final', 'evolucao caso'];

function municipioEsus(valor: string | null, uf: string | null, ctx: ContextoNormalizacao): { ibge: string | null; nome: string | null } {
  if (!valor) return { ibge: null, nome: null };
  const codigoIbge = valor.match(/^\s*(\d{6,7})\b/);
  if (codigoIbge) return { ibge: codigoIbge[1]!, nome: null };
  const sigla = siglaDaUf(uf);
  const achado = sigla ? ctx.municipiosPorNome?.get(chaveMunicipio(valor, sigla)) : undefined;
  return { ibge: achado ?? null, nome: achado ? null : valor };
}

function normalizarEsusNotifica(l: LinhaArquivo, ctx: ContextoNormalizacao): ResultadoNormalizacao {
  const sistema: SistemaOficial = 'ESUS_NOTIFICA';
  const avisos: string[] = [];
  const colunas: string[] = [];
  const c = (campo: string, ...origens: string[]) => {
    if (origens.some((o) => tem(l, o))) colunas.push(campo);
  };
  const numero = onlyDigits(texto(l, 'numero da notificacao') ?? '');
  if (!numero) return { recusado: 'Sem número da notificação' };
  if (!/^\d{8,15}$/.test(numero)) return { recusado: 'Número da notificação fora do formato (8 a 15 dígitos)' };
  const dn = lerData(texto(l, 'data da notificacao'));
  if (!dn.data) return { recusado: dn.invalida ? 'Data da notificação inválida' : 'Sem data da notificação' };
  if (dn.data > ctx.hoje) return { recusado: 'Data da notificação no futuro' };
  if (dn.data < PISO_NOTIFICACAO.ESUS_NOTIFICA!) return { recusado: 'Data da notificação anterior a 01/01/2020 (início do e-SUS Notifica)' };
  const duvidosas: string[] = [];
  if (dn.duvidosa) duvidosas.push('notificadoEm');

  const textoClassificacao = texto(l, 'classificacao final');
  const chaveClassificacao = normalizarNomePessoa(textoClassificacao);
  const classificacao = textoClassificacao ? (/^[1-6]$/.test(textoClassificacao) ? textoClassificacao : (CLASSIFICACAO_ESUS[chaveClassificacao] ?? null)) : null;
  if (textoClassificacao && !classificacao) avisos.push(`Classificação final não reconhecida: "${textoClassificacao}"`);
  const textoEvolucao = texto(l, 'evolucao caso');
  const evolucao = textoEvolucao ? (/^[1-7]$/.test(textoEvolucao) ? textoEvolucao : (EVOLUCAO_ESUS[normalizarNomePessoa(textoEvolucao)] ?? null)) : null;
  if (textoEvolucao && !evolucao) avisos.push(`Evolução do caso não reconhecida: "${textoEvolucao}"`);

  const ds = lerData(texto(l, 'data do inicio dos sintomas'));
  if (ds.invalida) avisos.push('Data do início dos sintomas inválida');
  if (ds.duvidosa) duvidosas.push('inicioSintomas');
  const de = lerData(texto(l, 'data de encerramento'));
  if (de.invalida) avisos.push('Data de encerramento inválida');
  if (de.duvidosa) duvidosas.push('encerradoEm');
  const notificacao = municipioEsus(texto(l, 'municipio da notificacao'), texto(l, 'estado da notificacao'), ctx);
  const residencia = municipioEsus(texto(l, 'municipio de residencia'), texto(l, 'estado de residencia'), ctx);
  if (notificacao.nome || residencia.nome) avisos.push('Município pelo nome, sem código IBGE na tabela do sistema: o nome ficou guardado');
  const sindromeGripal = Object.keys(l).some((k) => MARCAS_SG.some((m) => k.startsWith(m)));
  const grupo = sindromeGripal ? 'covid' : null;
  if (!grupo) avisos.push('Ficha do e-SUS Notifica sem as colunas da síndrome gripal: agravo não identificado');

  c('numero', 'numero da notificacao');
  c('notificadoEm', 'data da notificacao');
  colunas.push('semanaNotificacao');
  c('municipioNotificacao', 'municipio da notificacao');
  c('cnes', 'cnes notificacao');
  colunas.push('grupo');
  c('inicioSintomas', 'data do inicio dos sintomas');
  c('semanaSintomas', 'data do inicio dos sintomas');
  c('municipioResidencia', 'municipio de residencia');
  c('bairroNome', 'bairro');
  c('classificacao', 'classificacao final');
  c('evolucao', 'evolucao caso');
  c('encerradoEm', 'data de encerramento');
  c('excluido', 'evolucao caso');

  let identificacao: IdentificacaoRegistro | null = null;
  if (['nome completo', 'data de nascimento', 'sexo', 'nome completo da mae', 'cns', 'cpf'].some((x) => tem(l, x))) {
    const dnasc = lerData(texto(l, 'data de nascimento'));
    identificacao = {
      nome: texto(l, 'nome completo'),
      nascimento: dnasc.data,
      sexo: sexoDe(texto(l, 'sexo')),
      mae: texto(l, 'nome completo da mae'),
      cns: cnsDe(texto(l, 'cns')),
      cpf: cpfDe(texto(l, 'cpf')),
    };
    c('nome', 'nome completo');
    c('nascimento', 'data de nascimento');
    c('sexo', 'sexo');
    c('mae', 'nome completo da mae');
    c('cns', 'cns');
    c('cpf', 'cpf');
  }

  const extras: RegistroOficialNormalizado['extras'] = {};
  for (const x of EXTRAS_ESUS) {
    if (!tem(l, x)) continue;
    extras[x] = texto(l, x);
    colunas.push(`extras.${x}`);
  }
  if (tem(l, 'municipio da notificacao')) {
    extras['municipio da notificacao (nome)'] = notificacao.nome;
    colunas.push('extras.municipio da notificacao (nome)');
  }
  if (tem(l, 'municipio de residencia')) {
    extras['municipio de residencia (nome)'] = residencia.nome;
    colunas.push('extras.municipio de residencia (nome)');
  }
  extras.datas_duvidosas = duvidosas.length ? duvidosas.join(',') : null;
  colunas.push('extras.datas_duvidosas');
  if (duvidosas.length) avisos.push('Data em ISO com hora UTC de 13h ou mais: o dia pode ter vindo de outro fuso (marcada como duvidosa)');

  const registro: RegistroOficialNormalizado = {
    chave: chaveNatural({ sistema, tipo: 'INDIVIDUAL', numero, notificadoEm: dn.data, municipio: notificacao.ibge, agravo: null, cnes: null }),
    sistema,
    tipo: 'INDIVIDUAL',
    tipoArquivo: 'ESUS_NOTIFICA_CSV',
    numero,
    notificadoEm: dn.data,
    semanaNotificacao: semanaDaData(dn.data).codigo,
    municipioNotificacao: notificacao.ibge,
    cnes: cnesDe(texto(l, 'cnes notificacao')),
    agravo: null,
    tipoSuspeita: null,
    grupo,
    inicioSintomas: ds.data,
    semanaSintomas: ds.data ? semanaDaData(ds.data).codigo : null,
    municipioResidencia: residencia.ibge,
    bairroCodigo: null,
    bairroNome: texto(l, 'bairro'),
    classificacao,
    criterio: null,
    evolucao,
    encerradoEm: de.data,
    obitoEm: null,
    situacao: situacaoDoRegistro(sistema, null, classificacao, null),
    gravidade: null,
    excluido: evolucao === '7',
    sigiloso: !!grupo && !!ctx.sensiveis?.has(grupo),
    identificacao,
    extras,
    colunas,
  };
  return { registro, avisos };
}

export function normalizarRegistro(linha: LinhaArquivo, ctx: ContextoNormalizacao): ResultadoNormalizacao {
  switch (ctx.tipo) {
    case 'ESUS_NOTIFICA_CSV':
      return normalizarEsusNotifica(linha, ctx);
    case 'NINDINET':
    case 'AGRAVO_NET':
    case 'NNEGANET':
    case 'NSURTNET':
    case 'DENGON':
    case 'CHIKON':
    case 'ESUS_SINAN_CSV':
      return normalizarSinan(linha, ctx);
    default:
      return { recusado: 'Arquivo sem registros de notificação' };
  }
}
