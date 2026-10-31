import { isValidCns, isValidCpf } from '@omnisaude/shared';
import { CBO_POR_MODELO, CONDUTA, CONDUTA_ODONTO, DESFECHO_VISITA, JUSTIFICATIVA_SEM_CPF, LOCAL_ATENDIMENTO, MOTIVO_VISITA, TIPO_ATENDIMENTO, TIPO_DADO, TIPO_IMOVEL_LEDI } from './codes';
import { normalizeName } from './ledi';
import { lediFields } from './thrift';
import type { LediObject, LediValue } from './thrift';

/**
 * Validação prévia das fichas com as regras do dicionário do LEDI que o PEC aplica ao receber: evita a
 * "glosa" (ficha recusada) antes do envio. Não substitui a validação do PEC; cobre as regras mais frequentes.
 */

export interface LediIssue {
  path: string;
  message: string;
}

const MODEL_BY_TIPO: Record<number, keyof typeof CBO_POR_MODELO> = {
  [TIPO_DADO.CADASTRO_INDIVIDUAL]: 'CADASTRO_INDIVIDUAL',
  [TIPO_DADO.CADASTRO_DOMICILIAR]: 'CADASTRO_DOMICILIAR',
  [TIPO_DADO.ATENDIMENTO_INDIVIDUAL]: 'ATENDIMENTO_INDIVIDUAL',
  [TIPO_DADO.ATENDIMENTO_ODONTOLOGICO]: 'ATENDIMENTO_ODONTOLOGICO',
  [TIPO_DADO.ATIVIDADE_COLETIVA]: 'ATIVIDADE_COLETIVA',
  [TIPO_DADO.PROCEDIMENTOS]: 'PROCEDIMENTOS',
  [TIPO_DADO.VISITA_DOMICILIAR]: 'VISITA_DOMICILIAR',
  [TIPO_DADO.VACINACAO]: 'VACINACAO',
};

const str = (v: LediValue) => (typeof v === 'string' ? v : undefined);
const num = (v: LediValue) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined);
const obj = (v: LediValue) => (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? (v as LediObject) : undefined);
const arr = (v: LediValue) => (Array.isArray(v) ? v : undefined);

class Checker {
  readonly issues: LediIssue[] = [];
  constructor(
    private readonly now: Date,
    private readonly tipo: number,
  ) {}
  add(path: string, message: string) {
    this.issues.push({ path, message });
  }
  required(o: LediObject, path: string, struct: string) {
    for (const f of lediFields(struct)) if (f.required && (o[f.name] === undefined || o[f.name] === null)) this.add(`${path}.${f.name}`, 'campo obrigatório ausente');
  }
  cns(v: LediValue, path: string, required: boolean) {
    const s = str(v);
    if (!s) {
      if (required) this.add(path, 'CNS obrigatório');
      return;
    }
    if (!isValidCns(s)) this.add(path, `CNS inválido (${s})`);
  }
  cpf(v: LediValue, path: string) {
    const s = str(v);
    if (s && !isValidCpf(s)) this.add(path, `CPF inválido (${s})`);
  }
  cnes(v: LediValue, path: string) {
    if (!/^\d{7}$/.test(str(v) ?? '')) this.add(path, 'CNES deve ter 7 dígitos');
  }
  ibge(v: LediValue, path: string) {
    if (!/^\d{7}$/.test(str(v) ?? '')) this.add(path, 'código IBGE do município deve ter 7 dígitos');
  }
  ine(v: LediValue, path: string) {
    const s = str(v);
    if (s !== undefined && !/^\d{10}$/.test(s)) this.add(path, 'INE deve ter 10 dígitos');
  }
  cbo(v: LediValue, path: string) {
    const s = str(v) ?? '';
    if (!/^\d{6}$/.test(s)) {
      this.add(path, 'CBO deve ter 6 dígitos');
      return;
    }
    const model = MODEL_BY_TIPO[this.tipo];
    if (model && !CBO_POR_MODELO[model].includes(s)) this.add(path, `CBO ${s} não é aceita neste modelo de informação`);
  }
  dateNotFuture(v: LediValue, path: string) {
    const n = num(v);
    if (n === undefined) return;
    if (n > this.now.getTime() + 60_000) this.add(path, 'data posterior à data atual');
  }
  header(h: LediObject | undefined, path: string, varias: boolean) {
    if (!h) {
      this.add(path, 'cabeçalho (headerTransport) ausente');
      return;
    }
    if (varias) {
      const p = obj(h.lotacaoFormPrincipal);
      if (!p) this.add(`${path}.lotacaoFormPrincipal`, 'profissional responsável ausente');
      else this.lotacao(p, `${path}.lotacaoFormPrincipal`);
      const c = obj(h.lotacaoFormAtendimentoCompartilhado);
      if (c) this.lotacao(c, `${path}.lotacaoFormAtendimentoCompartilhado`, false);
    } else this.lotacao(h, path);
    if (num(h.dataAtendimento) === undefined) this.add(`${path}.dataAtendimento`, 'data do atendimento ausente');
    this.dateNotFuture(h.dataAtendimento, `${path}.dataAtendimento`);
    this.ibge(h.codigoIbgeMunicipio, `${path}.codigoIbgeMunicipio`);
  }
  lotacao(l: LediObject, path: string, checkCboModel = true) {
    this.cns(l.profissionalCNS, `${path}.profissionalCNS`, true);
    if (checkCboModel) this.cbo(l.cboCodigo_2002, `${path}.cboCodigo_2002`);
    else if (!/^\d{6}$/.test(str(l.cboCodigo_2002) ?? '')) this.add(`${path}.cboCodigo_2002`, 'CBO deve ter 6 dígitos');
    this.cnes(l.cnes, `${path}.cnes`);
    this.ine(l.ine, `${path}.ine`);
  }
  /** Identificação do cidadão nas fichas de atendimento: CNS ou CPF (com justificativa quando não há CPF). */
  cidadao(o: LediObject, path: string, names: { cns: string; cpf: string; semCpf: string; justificativa: string }) {
    const cns = str(o[names.cns]);
    const cpf = str(o[names.cpf]);
    if (cns) this.cns(cns, `${path}.${names.cns}`, false);
    if (cpf) this.cpf(cpf, `${path}.${names.cpf}`);
    const semCpf = o[names.semCpf];
    if (cpf && semCpf === true) this.add(`${path}.${names.semCpf}`, 'não pode ser true quando o CPF foi informado');
    if (!cpf) {
      if (semCpf !== true) this.add(`${path}.${names.semCpf}`, 'sem CPF, o marcador deve ser true');
      const j = num(o[names.justificativa]);
      if (j === undefined) this.add(`${path}.${names.justificativa}`, 'sem CPF, informe a justificativa (código do LEDI)');
      else if (!JUSTIFICATIVA_SEM_CPF[String(j)]) this.add(`${path}.${names.justificativa}`, `justificativa ${j} não consta da lista`);
    } else if (o[names.justificativa] !== undefined) this.add(`${path}.${names.justificativa}`, 'não pode ser preenchida quando o CPF foi informado');
  }
  atendimentoDatas(o: LediObject, path: string, dataAtendimento: number | undefined) {
    const ini = num(o.dataHoraInicialAtendimento);
    const fim = num(o.dataHoraFinalAtendimento);
    if (ini === undefined || fim === undefined) return;
    if (dataAtendimento !== undefined && ini < dataAtendimento - 86_400_000) this.add(`${path}.dataHoraInicialAtendimento`, 'anterior à data do atendimento do cabeçalho');
    if (fim < ini) this.add(`${path}.dataHoraFinalAtendimento`, 'anterior ao início do atendimento');
    this.dateNotFuture(fim, `${path}.dataHoraFinalAtendimento`);
  }
  codeIn(v: LediValue, table: Record<string, string>, path: string, label: string) {
    const n = num(v);
    if (n !== undefined && !table[String(n)]) this.add(path, `${label} ${n} não consta da tabela`);
  }
}

function checkCadastroIndividual(c: Checker, o: LediObject) {
  c.required(o, '$', 'CadastroIndividualThrift');
  c.header(obj(o.headerTransport), '$.headerTransport', false);
  const id = obj(o.identificacaoUsuarioCidadao);
  if (!id) {
    c.add('$.identificacaoUsuarioCidadao', 'identificação do cidadão ausente');
    return;
  }
  c.required(id, '$.identificacaoUsuarioCidadao', 'IdentificacaoUsuarioCidadaoThrift');
  const nome = str(id.nomeCidadao);
  if (!nome || normalizeName(nome) !== nome) c.add('$.identificacaoUsuarioCidadao.nomeCidadao', 'nome fora das regras do CADSUS (ao menos dois termos, só letras, maiúsculas)');
  const mae = str(id.nomeMaeCidadao);
  if (mae && normalizeName(mae) !== mae) c.add('$.identificacaoUsuarioCidadao.nomeMaeCidadao', 'nome da mãe fora das regras do CADSUS');
  if (!mae && id.desconheceNomeMae !== true) c.add('$.identificacaoUsuarioCidadao.nomeMaeCidadao', 'informe o nome da mãe ou marque desconhecido');
  c.cidadao(id, '$.identificacaoUsuarioCidadao', { cns: 'cnsCidadao', cpf: 'cpfCidadao', semCpf: 'stNaoPossuiCpf', justificativa: 'justificativaNaoPossuiCpf' });
  c.dateNotFuture(id.dataNascimentoCidadao, '$.identificacaoUsuarioCidadao.dataNascimentoCidadao');
  if (id.statusEhResponsavel !== false && (str(id.cnsResponsavelFamiliar) || str(id.cpfResponsavelFamiliar) || id.relacaoParentescoCidadao !== undefined))
    c.add('$.identificacaoUsuarioCidadao', 'documento ou parentesco do responsável só quando o cidadão não é o responsável familiar (statusEhResponsavel = false)');
  if (str(id.cnsResponsavelFamiliar) && str(id.cpfResponsavelFamiliar)) c.add('$.identificacaoUsuarioCidadao.cnsResponsavelFamiliar', 'informe só um documento do responsável (CNS ou CPF)');
  if (o.fichaAtualizada === true && (!str(o.uuidFichaOriginadora) || o.uuidFichaOriginadora === o.uuid)) c.add('$.uuidFichaOriginadora', 'atualização exige o uuid da ficha que originou o cadastro');
}

function checkCadastroDomiciliar(c: Checker, o: LediObject) {
  c.required(o, '$', 'CadastroDomiciliarThrift');
  c.header(obj(o.headerTransport), '$.headerTransport', false);
  const e = obj(o.enderecoLocalPermanencia);
  if (!e) c.add('$.enderecoLocalPermanencia', 'endereço ausente');
  else {
    if (!/^\d{8}$/.test(str(e.cep) ?? '')) c.add('$.enderecoLocalPermanencia.cep', 'CEP deve ter 8 dígitos');
    c.ibge(e.codigoIbgeMunicipio, '$.enderecoLocalPermanencia.codigoIbgeMunicipio');
    if (!str(e.nomeLogradouro)) c.add('$.enderecoLocalPermanencia.nomeLogradouro', 'logradouro ausente');
    if (!str(e.bairro)) c.add('$.enderecoLocalPermanencia.bairro', 'bairro ausente');
    if (!str(e.numeroDneUf)) c.add('$.enderecoLocalPermanencia.numeroDneUf', 'UF ausente');
    if (!str(e.tipoLogradouroNumeroDne)) c.add('$.enderecoLocalPermanencia.tipoLogradouroNumeroDne', 'tipo de logradouro ausente');
  }
  const m = obj(o.condicaoMoradia);
  if (!m) c.add('$.condicaoMoradia', 'condições de moradia ausentes');
  else {
    if (num(m.localizacao) === undefined) c.add('$.condicaoMoradia.localizacao', 'localização ausente');
    if (num(m.situacaoMoradiaPosseTerra) === undefined) c.add('$.condicaoMoradia.situacaoMoradiaPosseTerra', 'situação de moradia ausente');
  }
  const familias = arr(o.familias) ?? [];
  familias.forEach((f, i) => {
    const fo = obj(f);
    if (!fo) return;
    const cns = str(fo.numeroCnsResponsavel);
    const cpf = str(fo.cpfResponsavel);
    if (!cns && !cpf) c.add(`$.familias[${i}]`, 'responsável familiar sem CNS e sem CPF');
    if (cns && cpf) c.add(`$.familias[${i}]`, 'informe só um documento do responsável');
    if (cns) c.cns(cns, `$.familias[${i}].numeroCnsResponsavel`, false);
    if (cpf) c.cpf(cpf, `$.familias[${i}].cpfResponsavel`);
  });
  if (o.fichaAtualizada === true && (!str(o.uuidFichaOriginadora) || o.uuidFichaOriginadora === o.uuid)) c.add('$.uuidFichaOriginadora', 'atualização exige o uuid da ficha que originou o cadastro');
}

function checkAtendimentoIndividual(c: Checker, o: LediObject) {
  c.required(o, '$', 'FichaAtendimentoIndividualMasterThrift');
  const h = obj(o.headerTransport);
  c.header(h, '$.headerTransport', true);
  const list = arr(o.atendimentosIndividuais) ?? [];
  if (!list.length) c.add('$.atendimentosIndividuais', 'a ficha precisa de ao menos um atendimento');
  if (list.length > 99) c.add('$.atendimentosIndividuais', 'no máximo 99 atendimentos por ficha');
  list.forEach((item, i) => {
    const a = obj(item);
    if (!a) return;
    const p = `$.atendimentosIndividuais[${i}]`;
    for (const f of ['dataNascimento', 'localDeAtendimento', 'sexo', 'turno', 'tipoAtendimento', 'dataHoraInicialAtendimento', 'dataHoraFinalAtendimento', 'condutas', 'problemasCondicoes'])
      if (a[f] === undefined) c.add(`${p}.${f}`, 'campo obrigatório ausente');
    c.cidadao(a, p, { cns: 'cns', cpf: 'cpfCidadao', semCpf: 'stCidadaoNaoPossuiCpf', justificativa: 'justificativaCidadaoNaoPossuiCpf' });
    c.codeIn(a.localDeAtendimento, LOCAL_ATENDIMENTO, `${p}.localDeAtendimento`, 'local de atendimento');
    c.codeIn(a.tipoAtendimento, TIPO_ATENDIMENTO, `${p}.tipoAtendimento`, 'tipo de atendimento');
    c.atendimentoDatas(a, p, num(h?.dataAtendimento));
    const condutas = arr(a.condutas) ?? [];
    if (!condutas.length) c.add(`${p}.condutas`, 'informe ao menos uma conduta');
    if (new Set(condutas.map((x) => String(x))).size !== condutas.length) c.add(`${p}.condutas`, 'condutas repetidas');
    for (const k of condutas) c.codeIn(k, CONDUTA, `${p}.condutas`, 'conduta');
    const problemas = arr(a.problemasCondicoes) ?? [];
    if (!problemas.length) c.add(`${p}.problemasCondicoes`, 'informe ao menos um problema/condição (CIAP2 ou CID10)');
    problemas.forEach((pr, j) => {
      const po = obj(pr);
      if (!po) return;
      if (!str(po.ciap) && !str(po.cid10)) c.add(`${p}.problemasCondicoes[${j}]`, 'informe CIAP2 ou CID10');
      if (str(po.cid10) && !/^[A-Z]\d{2}\d?$/.test(str(po.cid10)!)) c.add(`${p}.problemasCondicoes[${j}].cid10`, `CID10 fora do formato (${po.cid10})`);
      if (str(po.ciap) && !/^[A-Z]\d{2}$/.test(str(po.ciap)!)) c.add(`${p}.problemasCondicoes[${j}].ciap`, `CIAP2 fora do formato (${po.ciap})`);
    });
    const cids = problemas.map((pr) => str(obj(pr)?.cid10)).filter(Boolean);
    if (new Set(cids).size !== cids.length) c.add(`${p}.problemasCondicoes`, 'CID10 repetida');
  });
}

function checkAtendimentoOdontologico(c: Checker, o: LediObject) {
  c.required(o, '$', 'FichaAtendimentoOdontologicoMasterThrift');
  const h = obj(o.headerTransport);
  c.header(h, '$.headerTransport', true);
  const list = arr(o.atendimentosOdontologicos) ?? [];
  if (!list.length) c.add('$.atendimentosOdontologicos', 'a ficha precisa de ao menos um atendimento');
  list.forEach((item, i) => {
    const a = obj(item);
    if (!a) return;
    const p = `$.atendimentosOdontologicos[${i}]`;
    for (const f of ['dtNascimento', 'gestante', 'localAtendimento', 'tipoAtendimento', 'tiposEncamOdonto', 'tiposVigilanciaSaudeBucal', 'sexo', 'turno', 'dataHoraInicialAtendimento', 'dataHoraFinalAtendimento'])
      if (a[f] === undefined) c.add(`${p}.${f}`, 'campo obrigatório ausente');
    c.cidadao(a, p, { cns: 'cnsCidadao', cpf: 'cpfCidadao', semCpf: 'stCidadaoNaoPossuiCpf', justificativa: 'justificativaCidadaoNaoPossuiCpf' });
    c.atendimentoDatas(a, p, num(h?.dataAtendimento));
    const condutas = arr(a.tiposEncamOdonto) ?? [];
    if (!condutas.length) c.add(`${p}.tiposEncamOdonto`, 'informe ao menos uma conduta');
    for (const k of condutas) c.codeIn(k, CONDUTA_ODONTO, `${p}.tiposEncamOdonto`, 'conduta odontológica');
    if (!(arr(a.tiposVigilanciaSaudeBucal) ?? []).length) c.add(`${p}.tiposVigilanciaSaudeBucal`, 'informe a vigilância em saúde bucal (99 = não identificado)');
  });
}

function checkProcedimentos(c: Checker, o: LediObject) {
  c.required(o, '$', 'FichaProcedimentoMasterThrift');
  const h = obj(o.headerTransport);
  c.header(h, '$.headerTransport', false);
  const list = arr(o.atendProcedimentos) ?? [];
  const totais = [
    'numTotalAfericaoPa',
    'numTotalGlicemiaCapilar',
    'numTotalAfericaoTemperatura',
    'numTotalMedicaoAltura',
    'numTotalCurativoSimples',
    'numTotalMedicaoPeso',
    'numTotalColetaMaterialParaExameLaboratorial',
  ].some((k) => num(o[k]));
  if (!list.length && !totais) c.add('$.atendProcedimentos', 'a ficha precisa de atendimentos ou dos totais de procedimentos consolidados');
  list.forEach((item, i) => {
    const a = obj(item);
    if (!a) return;
    const p = `$.atendProcedimentos[${i}]`;
    for (const f of ['dtNascimento', 'sexo', 'localAtendimento', 'turno', 'dataHoraInicialAtendimento', 'dataHoraFinalAtendimento']) if (a[f] === undefined) c.add(`${p}.${f}`, 'campo obrigatório ausente');
    c.cidadao(a, p, { cns: 'cnsCidadao', cpf: 'cpfCidadao', semCpf: 'stCidadaoNaoPossuiCpf', justificativa: 'justificativaCidadaoNaoPossuiCpf' });
    c.atendimentoDatas(a, p, num(h?.dataAtendimento));
    const procs = arr(a.procedimentos) ?? [];
    if (!procs.length && !obj(a.medicoes)) c.add(`${p}.procedimentos`, 'informe procedimentos (SIGTAP) ou medições');
    for (const pr of procs) if (!/^\d{10}$/.test(str(pr) ?? '')) c.add(`${p}.procedimentos`, `procedimento fora do formato SIGTAP (${String(pr)})`);
  });
}

function checkVacinacao(c: Checker, o: LediObject) {
  c.required(o, '$', 'FichaVacinacaoMasterThrift');
  const h = obj(o.headerTransport);
  c.header(h, '$.headerTransport', false);
  const list = arr(o.vacinacoes) ?? [];
  if (!list.length) c.add('$.vacinacoes', 'a ficha precisa de ao menos um atendimento de vacinação');
  list.forEach((item, i) => {
    const a = obj(item);
    if (!a) return;
    const p = `$.vacinacoes[${i}]`;
    for (const f of ['turno', 'dtNascimento', 'sexo', 'localAtendimento', 'viajante', 'dataHoraInicialAtendimento', 'dataHoraFinalAtendimento', 'vacinas'])
      if (a[f] === undefined) c.add(`${p}.${f}`, 'campo obrigatório ausente');
    c.cidadao(a, p, { cns: 'cnsCidadao', cpf: 'cpfCidadao', semCpf: 'stNaoPossuiCpf', justificativa: 'justificativaNaoPossuiCpf' });
    c.atendimentoDatas(a, p, num(h?.dataAtendimento));
    const vacinas = arr(a.vacinas) ?? [];
    if (!vacinas.length) c.add(`${p}.vacinas`, 'informe ao menos uma vacina');
    vacinas.forEach((v, j) => {
      const vo = obj(v);
      if (!vo) return;
      for (const f of ['imunobiologico', 'dose', 'stRegistroAnterior', 'stPesquisaClinica', 'viaAdministracao', 'localAplicacao']) if (vo[f] === undefined) c.add(`${p}.vacinas[${j}].${f}`, 'campo obrigatório ausente');
      if (vo.stRegistroAnterior !== true && !str(vo.coRndsFabricante)) c.add(`${p}.vacinas[${j}].coRndsFabricante`, 'fabricante (código RNDS) obrigatório em aplicação corrente');
    });
  });
}

function checkVisitaDomiciliar(c: Checker, o: LediObject) {
  c.required(o, '$', 'FichaVisitaDomiciliarMasterThrift');
  const h = obj(o.headerTransport);
  c.header(h, '$.headerTransport', false);
  const list = arr(o.visitasDomiciliares) ?? [];
  if (!list.length) c.add('$.visitasDomiciliares', 'a ficha precisa de ao menos uma visita');
  if (list.length > 99) c.add('$.visitasDomiciliares', 'no máximo 99 visitas por ficha');
  list.forEach((item, i) => {
    const v = obj(item);
    if (!v) return;
    const p = `$.visitasDomiciliares[${i}]`;
    for (const f of ['turno', 'desfecho', 'motivosVisita', 'tipoDeImovel']) if (v[f] === undefined) c.add(`${p}.${f}`, 'campo obrigatório ausente');
    c.codeIn(v.turno, { '1': 'Manhã', '2': 'Tarde', '3': 'Noite' }, `${p}.turno`, 'turno');
    c.codeIn(v.desfecho, DESFECHO_VISITA, `${p}.desfecho`, 'desfecho');
    c.codeIn(v.tipoDeImovel, TIPO_IMOVEL_LEDI, `${p}.tipoDeImovel`, 'tipo de imóvel');
    const motivos = arr(v.motivosVisita) ?? [];
    if (!motivos.length) c.add(`${p}.motivosVisita`, 'informe ao menos um motivo da visita');
    if (new Set(motivos.map((m) => String(m))).size !== motivos.length) c.add(`${p}.motivosVisita`, 'motivos repetidos');
    for (const m of motivos) c.codeIn(m, MOTIVO_VISITA, `${p}.motivosVisita`, 'motivo da visita');
    if (v.stForaArea !== true && !str(v.microArea)) c.add(`${p}.microArea`, 'informe a microárea ou marque fora de área');
    if (str(v.microArea) && !/^\d{2}$/.test(str(v.microArea)!)) c.add(`${p}.microArea`, 'microárea deve ter 2 dígitos');
    const identificado = str(v.cnsCidadao) || str(v.cpfCidadao) || v.dtNascimento !== undefined || v.sexo !== undefined;
    if (identificado) {
      c.cidadao(v, p, { cns: 'cnsCidadao', cpf: 'cpfCidadao', semCpf: 'stCidadaoNaoPossuiCpf', justificativa: 'justificativaCidadaoNaoPossuiCpf' });
      if (v.dtNascimento === undefined) c.add(`${p}.dtNascimento`, 'data de nascimento obrigatória quando a pessoa é identificada');
      if (v.sexo === undefined) c.add(`${p}.sexo`, 'sexo obrigatório quando a pessoa é identificada');
      c.dateNotFuture(v.dtNascimento, `${p}.dtNascimento`);
    } else if (num(v.tipoDeImovel) === 1 && num(v.desfecho) === 1) c.add(`${p}.cnsCidadao`, 'visita realizada a domicílio precisa identificar a pessoa visitada (CNS ou CPF)');
    const lat = num(v.latitude);
    const lng = num(v.longitude);
    if ((lat === undefined) !== (lng === undefined)) c.add(`${p}.latitude`, 'latitude e longitude devem vir juntas');
    if (lat !== undefined && (lat < -90 || lat > 90)) c.add(`${p}.latitude`, 'latitude fora do intervalo');
    if (lng !== undefined && (lng < -180 || lng > 180)) c.add(`${p}.longitude`, 'longitude fora do intervalo');
    if (num(v.glicemia) !== undefined && num(v.tipoGlicemia) === undefined) c.add(`${p}.tipoGlicemia`, 'informe o tipo da glicemia');
    const peso = num(v.pesoAcompanhamentoNutricional);
    if (peso !== undefined && (peso <= 0 || peso > 500)) c.add(`${p}.pesoAcompanhamentoNutricional`, 'peso fora do intervalo (kg)');
    const altura = num(v.alturaAcompanhamentoNutricional);
    if (altura !== undefined && (altura <= 0 || altura > 250)) c.add(`${p}.alturaAcompanhamentoNutricional`, 'altura fora do intervalo (cm)');
  });
}

const CHECKERS: Record<number, (c: Checker, o: LediObject) => void> = {
  [TIPO_DADO.VISITA_DOMICILIAR]: checkVisitaDomiciliar,
  [TIPO_DADO.CADASTRO_INDIVIDUAL]: checkCadastroIndividual,
  [TIPO_DADO.CADASTRO_DOMICILIAR]: checkCadastroDomiciliar,
  [TIPO_DADO.ATENDIMENTO_INDIVIDUAL]: checkAtendimentoIndividual,
  [TIPO_DADO.ATENDIMENTO_ODONTOLOGICO]: checkAtendimentoOdontologico,
  [TIPO_DADO.PROCEDIMENTOS]: checkProcedimentos,
  [TIPO_DADO.VACINACAO]: checkVacinacao,
};

/** Confere a ficha (objeto da estrutura raiz) com as regras do LEDI; lista vazia = nada a corrigir. */
export function validateFicha(tipo: number, ficha: LediObject, now = new Date()): LediIssue[] {
  const checker = new Checker(now, tipo);
  const fn = CHECKERS[tipo];
  if (!fn) return [{ path: '$', message: `tipo de ficha ${tipo} sem validação prévia` }];
  fn(checker, ficha);
  return checker.issues;
}
