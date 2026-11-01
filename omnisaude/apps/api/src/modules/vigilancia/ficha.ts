import { CODIGO_UF, idadeSinan, isValidCns, semanaDaData, SINAN_ESCOLARIDADE, SINAN_GESTANTE, SINAN_RACA, SINAN_ZONA } from '@omnisaude/shared';

/**
 * Ficha Individual de Notificação do Sinan Net v5 (campos 1 a 16 e 20 a 33; 17 a 19 são da notificação de surto).
 * Os nomes seguem o dicionário de dados oficial (TP_NOT, ID_AGRAVO, DT_NOTIFIC, ...). Domínios conferidos na ficha
 * e no instrucional publicados no portal Sinan.
 */
export const FORM_VERSION = 'SINAN_NET_FIN_V5';

const UF_POR_CODIGO = Object.fromEntries(Object.entries(CODIGO_UF).map(([sigla, codigo]) => [codigo, sigla]));
export const ufDoIbge = (ibge: string | null | undefined) => (ibge ? (UF_POR_CODIGO[ibge.slice(0, 2)] ?? null) : null);

/** Raça/cor do cadastro (códigos do e-SUS: 01 branca, 02 preta, 03 parda, 04 amarela, 05 indígena) → Sinan. */
const RACA_ESUS_PARA_SINAN: Record<string, string> = { '01': '1', '02': '2', '03': '4', '04': '3', '05': '5', '99': '9' };

/**
 * Escolaridade do cadastro (tabela do e-SUS) → Sinan. Aproximação: o e-SUS não diz se a etapa foi concluída;
 * o campo fica editável na ficha.
 */
const ESCOLARIDADE_ESUS_PARA_SINAN: Record<string, string> = {
  '01': '10',
  '02': '10',
  '03': '10',
  '04': '1',
  '05': '3',
  '06': '4',
  '07': '1',
  '08': '1',
  '09': '3',
  '10': '6',
  '11': '6',
  '12': '6',
  '13': '8',
  '14': '0',
  '15': '0',
};

export interface Ficha {
  formVersion: typeof FORM_VERSION;
  TP_NOT: '2';
  ID_AGRAVO: { nome: string; cid: string | null; item: number; subitem: string | null };
  DT_NOTIFIC: string | null;
  SG_UF_NOT: string | null;
  ID_MUNICIP: string | null;
  ID_UNIDADE: { cnes: string; nome: string };
  DT_SIN_PRI: string | null;
  NM_PACIENT: string;
  DT_NASC: string;
  NU_IDADE_N: { valor: number; unidade: 'H' | 'D' | 'M' | 'A'; codigo: string } | null;
  CS_SEXO: 'M' | 'F' | 'I';
  CS_GESTANT: string | null;
  CS_RACA: string | null;
  CS_ESCOL_N: string | null;
  ID_CNS_SUS: string | null;
  NM_MAE_PAC: string | null;
  SG_UF: string | null;
  ID_MN_RESI: string | null;
  ID_DISTRIT: string | null;
  NM_BAIRRO: string | null;
  NM_LOGRADO: string | null;
  NU_NUMERO: string | null;
  NM_COMPLEM: string | null;
  ID_GEO1: number | null;
  ID_GEO2: number | null;
  NM_REFEREN: string | null;
  NU_CEP: string | null;
  NU_TELEFON: string | null;
  CS_ZONA: string | null;
  ID_PAIS: string | null;
  notificador: { nome: string; cbo: string | null; funcao: string };
}

export interface DadosFicha {
  condicao: { name: string; item: number; subitem: string | null };
  codigo: string | null;
  unidade: { cnes: string; name: string; ibgeCode: string };
  paciente: {
    name: string;
    birthDate: Date;
    sex: string;
    racaCor: string | null;
    education: string | null;
    cns: string | null;
    motherName: string | null;
    ibgeCode: string | null;
    district: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    cep: string | null;
    phone: string | null;
  };
  gestante: boolean;
  residencia: { lat: number | null; lng: number | null };
  notificador: { nome: string; cbo: string | null; funcao: string };
  referencia: Date;
}

const cidFormatado = (c: string | null) => (c && c.length > 3 ? `${c.slice(0, 3)}.${c.slice(3)}` : c);

/** Monta a ficha a partir do cadastro: o que vem do cadastro aparece na tela como leitura, com atalho para atualizar. */
export function montarFicha(d: DadosFicha): Ficha {
  const sexo = d.paciente.sex === 'M' || d.paciente.sex === 'F' ? d.paciente.sex : 'I';
  const idade = idadeSinan(d.paciente.birthDate, d.referencia);
  const idadeFertil = idade.unidade === 'A' && idade.valor >= 10 && idade.valor <= 49;
  return {
    formVersion: FORM_VERSION,
    TP_NOT: '2',
    ID_AGRAVO: { nome: d.condicao.name, cid: cidFormatado(d.codigo), item: d.condicao.item, subitem: d.condicao.subitem },
    DT_NOTIFIC: null,
    SG_UF_NOT: ufDoIbge(d.unidade.ibgeCode),
    ID_MUNICIP: d.unidade.ibgeCode,
    ID_UNIDADE: { cnes: d.unidade.cnes, nome: d.unidade.name },
    DT_SIN_PRI: null,
    NM_PACIENT: d.paciente.name,
    DT_NASC: d.paciente.birthDate.toISOString().slice(0, 10),
    NU_IDADE_N: idade,
    CS_SEXO: sexo,
    // Gestante: obrigatório para mulher em idade fértil; "não se aplica" para os demais.
    CS_GESTANT: sexo === 'F' && idadeFertil ? (d.gestante ? '4' : null) : '6',
    CS_RACA: d.paciente.racaCor ? (RACA_ESUS_PARA_SINAN[d.paciente.racaCor] ?? '9') : '9',
    CS_ESCOL_N: d.paciente.education ? (ESCOLARIDADE_ESUS_PARA_SINAN[d.paciente.education] ?? '9') : idade.unidade === 'A' && idade.valor >= 7 ? '9' : '10',
    ID_CNS_SUS: d.paciente.cns,
    NM_MAE_PAC: d.paciente.motherName,
    SG_UF: ufDoIbge(d.paciente.ibgeCode),
    ID_MN_RESI: d.paciente.ibgeCode,
    ID_DISTRIT: null,
    NM_BAIRRO: d.paciente.district,
    NM_LOGRADO: d.paciente.street,
    NU_NUMERO: d.paciente.number,
    NM_COMPLEM: d.paciente.complement,
    ID_GEO1: d.residencia.lat,
    ID_GEO2: d.residencia.lng,
    NM_REFEREN: null,
    NU_CEP: d.paciente.cep,
    NU_TELEFON: d.paciente.phone,
    CS_ZONA: null,
    ID_PAIS: null,
    notificador: d.notificador,
  };
}

/** Campos da ficha que a pessoa pode alterar na tela (o resto vem do cadastro ou do contexto). */
export const CAMPOS_EDITAVEIS = ['CS_GESTANT', 'CS_RACA', 'CS_ESCOL_N', 'ID_DISTRIT', 'NM_REFEREN', 'CS_ZONA', 'ID_PAIS'] as const;

/** Validações da FIN v5 (instrucional e dicionário de dados): datas, sexo, CNS, CNES, gestante. Devolve os erros. */
export function validarFicha(f: Ficha, ctx: { notificadaEm: Date; sintomas: string | null; hoje: string }): string[] {
  const erros: string[] = [];
  const dtNot = f.DT_NOTIFIC ?? ctx.notificadaEm.toISOString().slice(0, 10);
  if (ctx.sintomas && ctx.sintomas > dtNot) erros.push('A data dos primeiros sintomas não pode ser posterior à data da notificação');
  if (dtNot > ctx.hoje) erros.push('A data da notificação não pode ser futura');
  if (!['M', 'F', 'I'].includes(f.CS_SEXO)) erros.push('Sexo inválido');
  if (f.ID_CNS_SUS && (f.ID_CNS_SUS.length !== 15 || !isValidCns(f.ID_CNS_SUS))) erros.push('Número do Cartão SUS inválido');
  if (!f.ID_UNIDADE?.cnes) erros.push('A unidade notificadora precisa do código CNES');
  if (!f.CS_GESTANT) erros.push('Informe se a paciente está gestante (campo 12)');
  else if (!SINAN_GESTANTE[f.CS_GESTANT]) erros.push('Valor inválido para gestante');
  if (f.CS_RACA && !SINAN_RACA[f.CS_RACA]) erros.push('Valor inválido para raça/cor');
  if (f.CS_ESCOL_N && !SINAN_ESCOLARIDADE[f.CS_ESCOL_N]) erros.push('Valor inválido para escolaridade');
  if (f.CS_ZONA && !SINAN_ZONA[f.CS_ZONA]) erros.push('Valor inválido para zona');
  return erros;
}

/** SEM_NOT e SEM_PRI no formato AAAASS. */
export function semanasDaFicha(dtNotific: string | null, dtSintomas: string | null) {
  return { SEM_NOT: dtNotific ? semanaDaData(dtNotific).codigo : null, SEM_PRI: dtSintomas ? semanaDaData(dtSintomas).codigo : null };
}
