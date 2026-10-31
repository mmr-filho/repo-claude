import { onlyDigits } from '@omnisaude/shared';
import {
  ABASTECIMENTO_AGUA_PARA_LEDI,
  DESTINO_LIXO_PARA_LEDI,
  ESCOLARIDADE_PARA_LEDI,
  ESGOTAMENTO_PARA_LEDI,
  LOCALIZACAO_MORADIA,
  MATERIAL_PAREDES_PARA_LEDI,
  NACIONALIDADE,
  PARENTESCO_PARA_LEDI,
  RACA_COR_PARA_LEDI,
  RENDA_PARA_LEDI,
  SEXO,
  SITUACAO_MORADIA_PARA_LEDI,
  TIPO_DOMICILIO_PARA_LEDI,
  TIPO_ENDERECO_LOGRADOURO,
  TIPO_IMOVEL_PARA_LEDI,
  TP_CDS_ORIGEM_TERCEIROS,
  TRABALHO_PARA_LEDI,
  TRATAMENTO_AGUA_PARA_LEDI,
} from './codes';
import { digits, epochDate, epochMs, ibge7, normalizeName, phoneDigits, splitLogradouro, ufDne } from './ledi';
import type { LediObject } from './thrift';

/**
 * Montagem das fichas do LEDI a partir de dados simples (sem dependência do banco). Cada função devolve o
 * objeto da estrutura raiz pronto para `encodeLedi`. Os códigos do cadastro do OmniSaúde são convertidos
 * para os do LEDI aqui; a validação prévia (validate.ts) aponta o que o PEC recusaria.
 */

export interface Lotacao {
  cns: string;
  cbo: string;
  cnes: string;
  ine?: string | null;
}

export interface HeaderUnico extends Lotacao {
  dataAtendimento: Date;
  codigoIbge: string;
}

export interface HeaderVarias {
  principal: Lotacao;
  compartilhado?: Lotacao | null;
  dataAtendimento: Date;
  codigoIbge: string;
}

export interface Cidadao {
  name: string;
  socialName?: string | null;
  birthDate: Date;
  sex: 'M' | 'F' | string;
  cpf?: string | null;
  cns?: string | null;
  /** Justificativa (código do LEDI) quando não há CPF; sem ela, o PEC recusa a ficha. */
  justificativaSemCpf?: number | null;
}

const sexo = (sex: string) => (sex === 'F' ? SEXO.FEMININO : sex === 'M' ? SEXO.MASCULINO : SEXO.IGNORADO);
const cpfOf = (c: Cidadao) => digits(c.cpf);
const cnsOf = (c: Cidadao) => digits(c.cns);

export function headerUnico(h: HeaderUnico): LediObject {
  return { profissionalCNS: onlyDigits(h.cns), cboCodigo_2002: h.cbo, cnes: h.cnes, ine: h.ine ?? undefined, dataAtendimento: epochMs(h.dataAtendimento), codigoIbgeMunicipio: h.codigoIbge };
}

function lotacao(l: Lotacao): LediObject {
  return { profissionalCNS: onlyDigits(l.cns), cboCodigo_2002: l.cbo, cnes: l.cnes, ine: l.ine ?? undefined };
}

export function headerVarias(h: HeaderVarias): LediObject {
  return {
    lotacaoFormPrincipal: lotacao(h.principal),
    lotacaoFormAtendimentoCompartilhado: h.compartilhado ? lotacao(h.compartilhado) : undefined,
    dataAtendimento: epochMs(h.dataAtendimento),
    codigoIbgeMunicipio: h.codigoIbge,
  };
}

// ─── Cadastro individual ──────────────────────────────────────────────────────

export interface CadastroIndividualInput {
  uuid: string;
  header: HeaderUnico;
  /** Primeira ficha (false) ou atualização (true, com o uuid da ficha que originou o cadastro). */
  atualizada: boolean;
  uuidOriginadora?: string;
  cidadao: Cidadao & {
    racaCor?: string | null;
    etnia?: string | null;
    /** Nacionalidade do cadastro: '010' brasileira; outros códigos viram estrangeiro. */
    nationality?: string | null;
    motherName?: string | null;
    fatherName?: string | null;
    phone?: string | null;
    email?: string | null;
    nis?: string | null;
    birthIbgeCode?: string | null;
    education?: string | null;
    workSituation?: string | null;
    occupationCbo?: string | null;
    /** '00' = responsável familiar. */
    kinship?: string | null;
    responsibleCns?: string | null;
    responsibleCpf?: string | null;
    homeless?: boolean;
    microArea?: string | null;
    deceasedAt?: Date | null;
  };
  condicoes?: {
    hipertensao?: boolean;
    diabetes?: boolean;
    gestante?: boolean;
    fumante?: boolean;
    acamado?: boolean;
    domiciliado?: boolean;
    doencaRespiratoria?: boolean;
    cancer?: boolean;
    avc?: boolean;
    infarto?: boolean;
    doencaCardiaca?: boolean;
    doencaRins?: boolean;
    hanseniase?: boolean;
    tuberculose?: boolean;
    saudeMental?: boolean;
  };
}

export function buildCadastroIndividual(input: CadastroIndividualInput): LediObject {
  const c = input.cidadao;
  const cpf = cpfOf(c);
  // Sem família vinculada não se afirma nada sobre a responsabilidade familiar (campo opcional no LEDI).
  const responsible = c.kinship === '00' ? true : c.kinship || c.responsibleCns || c.responsibleCpf ? false : undefined;
  const identificacao: LediObject = {
    nomeCidadao: normalizeName(c.name) ?? c.name.toUpperCase(),
    nomeSocial: c.socialName ? (normalizeName(c.socialName) ?? undefined) : undefined,
    dataNascimentoCidadao: epochDate(c.birthDate),
    sexoCidadao: sexo(c.sex),
    racaCorCidadao: RACA_COR_PARA_LEDI[c.racaCor ?? ''] ?? RACA_COR_PARA_LEDI['03'],
    etnia: c.racaCor === '05' && c.etnia ? Number(c.etnia) : undefined,
    nacionalidadeCidadao: !c.nationality || c.nationality === '010' ? NACIONALIDADE.BRASILEIRA : NACIONALIDADE.ESTRANGEIRO,
    codigoIbgeMunicipioNascimento: ibge7(c.birthIbgeCode),
    nomeMaeCidadao: c.motherName ? (normalizeName(c.motherName) ?? undefined) : undefined,
    desconheceNomeMae: c.motherName ? undefined : true,
    nomePaiCidadao: c.fatherName ? (normalizeName(c.fatherName) ?? undefined) : undefined,
    desconheceNomePai: c.fatherName ? undefined : true,
    cnsCidadao: cnsOf(c),
    cpfCidadao: cpf,
    stNaoPossuiCpf: !cpf,
    justificativaNaoPossuiCpf: cpf ? undefined : (c.justificativaSemCpf ?? undefined),
    telefoneCelular: phoneDigits(c.phone),
    emailCidadao: c.email ?? undefined,
    numeroNisPisPasep: digits(c.nis),
    statusEhResponsavel: responsible,
    cnsResponsavelFamiliar: responsible === false && !c.responsibleCpf ? digits(c.responsibleCns) : undefined,
    cpfResponsavelFamiliar: responsible === false ? digits(c.responsibleCpf) : undefined,
    microArea: c.microArea ?? undefined,
  };
  const socio: LediObject = {
    grauInstrucaoCidadao: c.education ? ESCOLARIDADE_PARA_LEDI[c.education] : undefined,
    situacaoMercadoTrabalhoCidadao: c.workSituation ? TRABALHO_PARA_LEDI[c.workSituation] : undefined,
    ocupacaoCodigoCbo2002: c.occupationCbo ?? undefined,
    relacaoParentescoCidadao: responsible === false && c.kinship ? PARENTESCO_PARA_LEDI[c.kinship] : undefined,
    statusDesejaInformarOrientacaoSexual: false,
    statusDesejaInformarIdentidadeGenero: false,
  };
  const k = input.condicoes;
  const condicoes: LediObject | undefined = k
    ? {
        statusTemHipertensaoArterial: k.hipertensao,
        statusTemDiabetes: k.diabetes,
        statusEhGestante: k.gestante,
        statusEhFumante: k.fumante,
        statusEstaAcamado: k.acamado,
        statusEstaDomiciliado: k.domiciliado,
        statusTemDoencaRespiratoria: k.doencaRespiratoria,
        statusTemTeveCancer: k.cancer,
        statusTeveAvcDerrame: k.avc,
        statusTeveInfarto: k.infarto,
        statusTeveDoencaCardiaca: k.doencaCardiaca,
        statusTemTeveDoencasRins: k.doencaRins,
        statusTemHanseniase: k.hanseniase,
        statusTemTuberculose: k.tuberculose,
        statusDiagnosticoMental: k.saudeMental,
      }
    : undefined;
  const saida: LediObject | undefined = c.deceasedAt ? { motivoSaidaCidadao: 135, dataObito: epochDate(c.deceasedAt) } : undefined;
  return {
    identificacaoUsuarioCidadao: identificacao,
    informacoesSocioDemograficas: socio,
    condicoesDeSaude: condicoes,
    emSituacaoDeRua: c.homeless ? { statusSituacaoRua: true } : undefined,
    saidaCidadaoCadastro: saida,
    fichaAtualizada: input.atualizada,
    tpCdsOrigem: TP_CDS_ORIGEM_TERCEIROS,
    uuid: input.uuid,
    uuidFichaOriginadora: input.atualizada ? (input.uuidOriginadora ?? input.uuid) : input.uuid,
    headerTransport: headerUnico(input.header),
  };
}

// ─── Cadastro domiciliar ──────────────────────────────────────────────────────

export interface FamiliaInput {
  responsavel: { cns?: string | null; cpf?: string | null; birthDate?: Date | null };
  membros: number;
  numeroProntuario?: string | null;
  renda?: string | null;
  resideDesde?: Date | null;
}

export interface CadastroDomiciliarInput {
  uuid: string;
  header: HeaderUnico;
  atualizada: boolean;
  uuidOriginadora?: string;
  endereco: {
    street?: string | null;
    number?: string | null;
    complement?: string | null;
    district?: string | null;
    cep?: string | null;
    ibgeCode?: string | null;
    uf?: string | null;
    phone?: string | null;
    microArea?: string | null;
  };
  moradia: {
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
    residents?: number | null;
    /** 'URBANA' | 'RURAL' | 'PERIURBANA'; padrão urbana. */
    location?: string | null;
  };
  familias: FamiliaInput[];
  latitude?: number | null;
  longitude?: number | null;
}

export function buildCadastroDomiciliar(input: CadastroDomiciliarInput): LediObject {
  const e = input.endereco;
  const m = input.moradia;
  const logradouro = e.street ? splitLogradouro(e.street) : { tipo: '081', nome: '' };
  const numero = (e.number ?? '').trim();
  const familias = input.familias.map((f): LediObject => {
    const cpf = digits(f.responsavel.cpf);
    return {
      numeroCnsResponsavel: cpf ? undefined : digits(f.responsavel.cns),
      cpfResponsavel: cpf,
      dataNascimentoResponsavel: f.responsavel.birthDate ? epochDate(f.responsavel.birthDate) : undefined,
      numeroMembrosFamilia: f.membros,
      numeroProntuario: f.numeroProntuario ?? undefined,
      rendaFamiliar: f.renda ? RENDA_PARA_LEDI[f.renda] : undefined,
      resideDesde: f.resideDesde ? epochDate(f.resideDesde) : undefined,
      stMudanca: false,
    };
  });
  const location = (m.location ?? 'URBANA').toUpperCase();
  return {
    enderecoLocalPermanencia: {
      bairro: (e.district ?? '').toUpperCase(),
      cep: digits(e.cep),
      codigoIbgeMunicipio: ibge7(e.ibgeCode),
      complemento: e.complement ?? undefined,
      nomeLogradouro: logradouro.nome,
      numero: numero || 'SN',
      stSemNumero: numero ? undefined : true,
      numeroDneUf: ufDne(e.uf),
      tipoLogradouroNumeroDne: logradouro.tipo,
      telefoneContato: phoneDigits(e.phone),
      microArea: e.microArea ?? undefined,
    },
    condicaoMoradia: {
      localizacao: location === 'RURAL' ? Number(Object.keys(LOCALIZACAO_MORADIA)[1]) : location === 'PERIURBANA' ? Number(Object.keys(LOCALIZACAO_MORADIA)[2]) : Number(Object.keys(LOCALIZACAO_MORADIA)[0]),
      situacaoMoradiaPosseTerra: m.tenure ? SITUACAO_MORADIA_PARA_LEDI[m.tenure] : undefined,
      tipoDomicilio: m.dwellingType ? TIPO_DOMICILIO_PARA_LEDI[m.dwellingType] : undefined,
      materialPredominanteParedesExtDomicilio: m.wallMaterial ? MATERIAL_PAREDES_PARA_LEDI[m.wallMaterial] : undefined,
      abastecimentoAgua: m.waterSupply ? ABASTECIMENTO_AGUA_PARA_LEDI[m.waterSupply] : undefined,
      aguaConsumoDomicilio: m.waterTreatment ? TRATAMENTO_AGUA_PARA_LEDI[m.waterTreatment] : undefined,
      formaEscoamentoBanheiro: m.sewage ? ESGOTAMENTO_PARA_LEDI[m.sewage] : undefined,
      destinoLixo: m.garbage ? DESTINO_LIXO_PARA_LEDI[m.garbage] : undefined,
      stDisponibilidadeEnergiaEletrica: m.electricity ?? undefined,
      nuComodos: m.rooms ? String(m.rooms) : undefined,
      nuMoradores: m.residents ? String(m.residents) : undefined,
    },
    familias,
    fichaAtualizada: input.atualizada,
    tpCdsOrigem: TP_CDS_ORIGEM_TERCEIROS,
    uuid: input.uuid,
    uuidFichaOriginadora: input.atualizada ? (input.uuidOriginadora ?? input.uuid) : input.uuid,
    tipoDeImovel: TIPO_IMOVEL_PARA_LEDI[m.propertyType ?? '01'] ?? 1,
    tipoEndereco: TIPO_ENDERECO_LOGRADOURO,
    headerTransport: headerUnico(input.header),
    latitude: input.latitude ?? undefined,
    longitude: input.longitude ?? undefined,
    stAnimaisNoDomicilio: undefined,
  };
}

// ─── Atendimento individual ───────────────────────────────────────────────────

export interface Medicoes {
  systolic?: number | null;
  diastolic?: number | null;
  heartRate?: number | null;
  respiratoryRate?: number | null;
  temperature?: number | null;
  spo2?: number | null;
  glucose?: number | null;
  weightKg?: number | null;
  heightCm?: number | null;
}

export function medicoes(m: Medicoes | null | undefined): LediObject | undefined {
  if (!m) return undefined;
  const out: LediObject = {
    pressaoArterialSistolica: m.systolic ?? undefined,
    pressaoArterialDiastolica: m.diastolic ?? undefined,
    frequenciaCardiaca: m.heartRate ?? undefined,
    frequenciaRespiratoria: m.respiratoryRate ?? undefined,
    temperatura: m.temperature ?? undefined,
    saturacaoO2: m.spo2 ?? undefined,
    glicemiaCapilar: m.glucose ?? undefined,
    tipoGlicemiaCapilar: m.glucose ? 3 : undefined,
    peso: m.weightKg ?? undefined,
    altura: m.heightCm ?? undefined,
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

export interface ProblemaCondicao {
  ciap?: string | null;
  cid10?: string | null;
}

export interface AtendimentoIndividualInput {
  cidadao: Cidadao;
  numeroProntuario?: string | null;
  localAtendimento: number;
  turno: 1 | 2 | 3;
  tipoAtendimento: number;
  inicio: Date;
  fim: Date;
  medicoes?: Medicoes | null;
  problemas: ProblemaCondicao[];
  condutas: number[];
  exames?: { codigo: string; solicitado?: boolean; avaliado?: boolean }[];
  ficouEmObservacao?: boolean;
}

export interface FichaAtendimentoIndividualInput {
  uuid: string;
  header: HeaderVarias;
  atendimentos: AtendimentoIndividualInput[];
}

const normalizeCid = (c: string) => c.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export function atendimentoIndividual(a: AtendimentoIndividualInput): LediObject {
  const cpf = cpfOf(a.cidadao);
  return {
    numeroProntuario: a.numeroProntuario ?? undefined,
    cns: cnsOf(a.cidadao),
    cpfCidadao: cpf,
    stCidadaoNaoPossuiCpf: !cpf,
    justificativaCidadaoNaoPossuiCpf: cpf ? undefined : (a.cidadao.justificativaSemCpf ?? undefined),
    dataNascimento: epochDate(a.cidadao.birthDate),
    sexo: sexo(a.cidadao.sex),
    localDeAtendimento: a.localAtendimento,
    turno: a.turno,
    tipoAtendimento: a.tipoAtendimento,
    dataHoraInicialAtendimento: epochMs(a.inicio),
    dataHoraFinalAtendimento: epochMs(a.fim),
    medicoes: medicoes(a.medicoes),
    problemasCondicoes: a.problemas.map((p): LediObject => ({ ciap: p.ciap ? normalizeCid(p.ciap) : undefined, cid10: p.cid10 ? normalizeCid(p.cid10) : undefined, isAvaliado: true })),
    condutas: [...new Set(a.condutas)],
    exame: a.exames?.length ? a.exames.map((e): LediObject => ({ codigoExame: e.codigo, solicitadoAvaliado: [...(e.solicitado ? ['S'] : []), ...(e.avaliado ? ['A'] : [])] })) : undefined,
    ficouEmObservacao: a.ficouEmObservacao,
  };
}

export function buildAtendimentoIndividual(input: FichaAtendimentoIndividualInput): LediObject {
  return { headerTransport: headerVarias(input.header), atendimentosIndividuais: input.atendimentos.map(atendimentoIndividual), uuidFicha: input.uuid, tpCdsOrigem: TP_CDS_ORIGEM_TERCEIROS };
}

// ─── Atendimento odontológico ─────────────────────────────────────────────────

export interface AtendimentoOdontologicoInput {
  cidadao: Cidadao;
  numeroProntuario?: string | null;
  gestante?: boolean;
  necessidadesEspeciais?: boolean;
  localAtendimento: number;
  tipoAtendimento: number;
  turno: 1 | 2 | 3;
  inicio: Date;
  fim: Date;
  condutas: number[];
  vigilancia: number[];
  tipoConsulta?: number | null;
  procedimentos?: { codigo: string; quantidade: number }[];
  problemas?: ProblemaCondicao[];
  medicoes?: Medicoes | null;
}

export interface FichaAtendimentoOdontologicoInput {
  uuid: string;
  header: HeaderVarias;
  atendimentos: AtendimentoOdontologicoInput[];
}

export function buildAtendimentoOdontologico(input: FichaAtendimentoOdontologicoInput): LediObject {
  return {
    uuidFicha: input.uuid,
    headerTransport: headerVarias(input.header),
    tpCdsOrigem: TP_CDS_ORIGEM_TERCEIROS,
    atendimentosOdontologicos: input.atendimentos.map((a): LediObject => {
      const cpf = cpfOf(a.cidadao);
      return {
        dtNascimento: epochDate(a.cidadao.birthDate),
        cnsCidadao: cnsOf(a.cidadao),
        cpfCidadao: cpf,
        stCidadaoNaoPossuiCpf: !cpf,
        justificativaCidadaoNaoPossuiCpf: cpf ? undefined : (a.cidadao.justificativaSemCpf ?? undefined),
        numProntuario: a.numeroProntuario ?? undefined,
        gestante: a.gestante ?? false,
        necessidadesEspeciais: a.necessidadesEspeciais,
        localAtendimento: a.localAtendimento,
        tipoAtendimento: a.tipoAtendimento,
        tiposEncamOdonto: [...new Set(a.condutas)],
        tiposVigilanciaSaudeBucal: [...new Set(a.vigilancia)],
        tiposConsultaOdonto: a.tipoConsulta ? [a.tipoConsulta] : undefined,
        procedimentosRealizados: a.procedimentos?.length ? a.procedimentos.map((p): LediObject => ({ coMsProcedimento: p.codigo, quantidade: p.quantidade })) : undefined,
        sexo: sexo(a.cidadao.sex),
        turno: a.turno,
        dataHoraInicialAtendimento: epochMs(a.inicio),
        dataHoraFinalAtendimento: epochMs(a.fim),
        medicoes: medicoes(a.medicoes),
        problemasCondicoes: a.problemas?.length
          ? a.problemas.map((p): LediObject => ({ ciap: p.ciap ? normalizeCid(p.ciap) : undefined, cid10: p.cid10 ? normalizeCid(p.cid10) : undefined, isAvaliado: true }))
          : undefined,
      };
    }),
  };
}

// ─── Procedimentos ────────────────────────────────────────────────────────────

export interface ProcedimentoAtendimentoInput {
  cidadao: Cidadao;
  numeroProntuario?: string | null;
  localAtendimento: number;
  turno: 1 | 2 | 3;
  inicio: Date;
  fim: Date;
  /** Códigos SIGTAP (10 dígitos) dos procedimentos realizados. */
  procedimentos: string[];
  medicoes?: Medicoes | null;
  escutaInicial?: boolean;
}

export interface FichaProcedimentosInput {
  uuid: string;
  header: HeaderUnico;
  atendimentos: ProcedimentoAtendimentoInput[];
  totais?: { afericaoPa?: number; glicemiaCapilar?: number; afericaoTemperatura?: number; medicaoAltura?: number; curativoSimples?: number; medicaoPeso?: number; coletaExame?: number };
}

export function buildProcedimentos(input: FichaProcedimentosInput): LediObject {
  const t = input.totais ?? {};
  return {
    uuidFicha: input.uuid,
    tpCdsOrigem: TP_CDS_ORIGEM_TERCEIROS,
    headerTransport: headerUnico(input.header),
    atendProcedimentos: input.atendimentos.length
      ? input.atendimentos.map((a): LediObject => {
          const cpf = cpfOf(a.cidadao);
          return {
            numProntuario: a.numeroProntuario ?? undefined,
            cnsCidadao: cnsOf(a.cidadao),
            cpfCidadao: cpf,
            stCidadaoNaoPossuiCpf: !cpf,
            justificativaCidadaoNaoPossuiCpf: cpf ? undefined : (a.cidadao.justificativaSemCpf ?? undefined),
            dtNascimento: epochDate(a.cidadao.birthDate),
            sexo: sexo(a.cidadao.sex),
            localAtendimento: a.localAtendimento,
            turno: a.turno,
            statusEscutaInicialOrientacao: a.escutaInicial,
            procedimentos: a.procedimentos.length ? [...new Set(a.procedimentos.map((p) => p.replace(/\D/g, '')))] : undefined,
            dataHoraInicialAtendimento: epochMs(a.inicio),
            dataHoraFinalAtendimento: epochMs(a.fim),
            medicoes: medicoes(a.medicoes),
          };
        })
      : undefined,
    numTotalAfericaoPa: t.afericaoPa || undefined,
    numTotalGlicemiaCapilar: t.glicemiaCapilar || undefined,
    numTotalAfericaoTemperatura: t.afericaoTemperatura || undefined,
    numTotalMedicaoAltura: t.medicaoAltura || undefined,
    numTotalCurativoSimples: t.curativoSimples || undefined,
    numTotalMedicaoPeso: t.medicaoPeso || undefined,
    numTotalColetaMaterialParaExameLaboratorial: t.coletaExame || undefined,
  };
}

// ─── Vacinação ────────────────────────────────────────────────────────────────

export interface VacinaInput {
  imunobiologico: number;
  estrategia?: number | null;
  dose: number;
  lote?: string | null;
  fabricanteRnds?: string | null;
  viaAdministracao: number;
  localAplicacao: number;
  registroAnterior?: boolean;
  dataRegistroAnterior?: Date | null;
}

export interface VacinacaoAtendimentoInput {
  cidadao: Cidadao;
  numeroProntuario?: string | null;
  turno: 1 | 2 | 3;
  localAtendimento: number;
  viajante?: boolean;
  gestante?: boolean;
  puerpera?: boolean;
  inicio: Date;
  fim: Date;
  vacinas: VacinaInput[];
}

export interface FichaVacinacaoInput {
  uuid: string;
  header: HeaderUnico;
  atendimentos: VacinacaoAtendimentoInput[];
}

export function buildVacinacao(input: FichaVacinacaoInput): LediObject {
  return {
    uuidFicha: input.uuid,
    tpCdsOrigem: TP_CDS_ORIGEM_TERCEIROS,
    headerTransport: headerUnico(input.header),
    vacinacoes: input.atendimentos.map((a): LediObject => {
      const cpf = cpfOf(a.cidadao);
      return {
        turno: a.turno,
        numProntuario: a.numeroProntuario ?? undefined,
        cnsCidadao: cnsOf(a.cidadao),
        cpfCidadao: cpf,
        stNaoPossuiCpf: !cpf,
        justificativaNaoPossuiCpf: cpf ? undefined : (a.cidadao.justificativaSemCpf ?? undefined),
        dtNascimento: epochDate(a.cidadao.birthDate),
        sexo: sexo(a.cidadao.sex),
        localAtendimento: a.localAtendimento,
        viajante: a.viajante ?? false,
        gestante: a.gestante,
        puerpera: a.puerpera,
        dataHoraInicialAtendimento: epochMs(a.inicio),
        dataHoraFinalAtendimento: epochMs(a.fim),
        vacinas: a.vacinas.map(
          (v): LediObject => ({
            imunobiologico: v.imunobiologico,
            estrategiaVacinacao: v.estrategia ?? 1,
            dose: v.dose,
            lote: v.lote ?? undefined,
            coRndsFabricante: v.fabricanteRnds ?? undefined,
            stRegistroAnterior: v.registroAnterior ?? false,
            dataRegistroAnterior: v.dataRegistroAnterior ? epochDate(v.dataRegistroAnterior) : undefined,
            stPesquisaClinica: false,
            viaAdministracao: v.viaAdministracao,
            localAplicacao: v.localAplicacao,
          }),
        ),
      };
    }),
  };
}
