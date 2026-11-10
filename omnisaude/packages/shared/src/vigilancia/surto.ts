/**
 * Notificação de surto (VIG-1c): tipo 3 da Ficha de Notificação do Sinan Net, sem paciente, com a planilha de
 * acompanhamento (uma linha por caso) e a investigação. Domínios da ficha e do dicionário de dados (Investigação de
 * Surto v5), regras de sugestão de aglomerado (o sistema sugere, a vigilância confirma) e a validação de cada etapa
 * pelo Manual de Normas e Rotinas do Sinan (2007), item 5.3.1. Ver contingencia-surto-negativa.md, A13 a A26.
 */

/** Campo 19 da ficha (CS_LOCAL): local inicial de ocorrência. */
export const LOCAL_INICIAL_SURTO: Record<string, string> = {
  '1': 'Residência',
  '2': 'Hospital/Unidade de Saúde',
  '3': 'Creche/Escola',
  '4': 'Asilo',
  '5': 'Outras instituições',
  '6': 'Restaurante/Padaria',
  '7': 'Eventos',
  '8': 'Casos dispersos no bairro',
  '9': 'Casos dispersos pelo município',
  '10': 'Casos dispersos em mais de um município',
  '11': 'Outros',
};

/** Delimitação espacial no encerramento (DELIMITA): as mesmas 11 categorias do local inicial. */
export const DELIMITACAO_SURTO: Record<string, string> = { ...LOCAL_INICIAL_SURTO };

/** Campo 25 (CS_TRANS): modo provável de transmissão. */
export const MODO_TRANSMISSAO: Record<string, string> = { '1': 'Direta', '2': 'Indireta', '9': 'Ignorado' };

/** Campo 26 (TP_INDIRET guarda o código; CS_VEICULO, o texto do "outro"): veículo de transmissão. */
export const VEICULO_TRANSMISSAO: Record<string, string> = {
  '1': 'Alimento/água',
  '2': 'Recursos hídricos contaminados',
  '3': 'Vetor',
  '4': 'Produto',
  '5': 'Fômite',
  '6': 'Outro',
  '9': 'Ignorado',
};

/**
 * Síndromes do surto de agravo inusitado (abordagem sindrômica do Sinan). O código vem só de fonte secundária (tabela
 * de agravos de um Sinan Net de terceiros): conferir com um NSURTNET real antes de exportar.
 */
export const SINDROMES_SURTO: Record<string, { nome: string; codigo: string | null }> = {
  DIARREICA_AGUDA_SANGUINOLENTA: { nome: 'Síndrome diarreica aguda sanguinolenta', codigo: 'A08' },
  ICTERICA_AGUDA: { nome: 'Síndrome ictérica aguda', codigo: 'R17' },
  FEBRE_HEMORRAGICA_AGUDA: { nome: 'Síndrome de febre hemorrágica aguda', codigo: 'D699' },
  RESPIRATORIA_AGUDA: { nome: 'Síndrome respiratória aguda', codigo: 'J07' },
  NEUROLOGICA_AGUDA: { nome: 'Síndrome neurológica aguda', codigo: 'G043' },
  INSUFICIENCIA_RENAL_AGUDA: { nome: 'Síndrome da insuficiência renal aguda', codigo: 'N199' },
  OUTRAS: { nome: 'Outras síndromes', codigo: 'R699' },
};

/** Planilha de acompanhamento (CLASSI_FIN do caso). */
export const CLASSIFICACAO_CASO_SURTO: Record<string, string> = { '1': 'Confirmado', '2': 'Descartado', '3': 'Inconclusivo' };

/**
 * Critério de confirmação do caso, pelo dicionário de dados. A legenda da planilha impressa diverge (1 laboratorial,
 * 2 clínico-epidemiológico, 3 clínico): conferir com um NSURTNET real.
 */
export const CRITERIO_CASO_SURTO: Record<string, string> = {
  '1': 'Clínico-epidemiológico',
  '2': 'Laboratorial clínico',
  '3': 'Laboratorial bromatológico',
  '4': 'Laboratorial clínico-bromatológico',
  '5': 'Inconclusivo',
};

/** Por que o surto vai ao módulo de surto do Sinan (manual 3.1.1 e 5.3.1). */
export type CategoriaSurto = 'SINDROMICO' | 'FORA_DA_LISTA' | 'DA_LISTA' | 'DTA';

export const CATEGORIA_SURTO: Record<CategoriaSurto, string> = {
  SINDROMICO: 'Agravo inusitado (pela síndrome)',
  FORA_DA_LISTA: 'Doença fora da lista nacional',
  DA_LISTA: 'Doença da lista (registro agregado)',
  DTA: 'Doença transmitida por alimento (DTA)',
};

export type StatusSurto = 'ABERTO' | 'ENCERRADO' | 'DESCARTADO';

export const ROTULO_STATUS_SURTO: Record<StatusSurto, string> = { ABERTO: 'Aberto', ENCERRADO: 'Encerrado', DESCARTADO: 'Descartado' };

/** Eventos da linha do tempo do surto. */
export type TipoEventoSurto = 'CRIADO' | 'EDITADO' | 'COMUNICADO' | 'CASO_VINCULADO' | 'CASO_RETIRADO' | 'INVESTIGADO' | 'ENCERRADO' | 'DESCARTADO' | 'NUMERO_OFICIAL';

export const ROTULO_EVENTO_SURTO: Record<TipoEventoSurto, string> = {
  CRIADO: 'Notificação do surto',
  EDITADO: 'Edição',
  COMUNICADO: 'Comunicação',
  CASO_VINCULADO: 'Caso incluído',
  CASO_RETIRADO: 'Caso retirado',
  INVESTIGADO: 'Investigação',
  ENCERRADO: 'Encerramento',
  DESCARTADO: 'Descarte',
  NUMERO_OFICIAL: 'Número do Sinan',
};

/** Prazo da notificação de surto à SMS, contado do conhecimento (imediata; ESP também à SES e ao MS). */
export const PRAZO_SURTO_HORAS = 24;

/** Vínculo entre os casos de um aglomerado. */
export type TipoVinculoSurto = 'QUARTEIRAO' | 'BAIRRO' | 'UNIDADE';

/** Regra de sugestão de surto. */
export interface RegraSurto {
  id: string;
  /** Grupos do catálogo; ['*'] = qualquer. */
  grupos: string[];
  excetoGrupos?: string[];
  vinculo: TipoVinculoSurto;
  /** Casos na janela para sugerir. */
  minimo: number;
  janelaDias: number;
  /** Só unidade hospitalar (ex.: varicela em ambiente hospitalar). Acréscimo da fundação ao desenho; a F1 pode trocar. */
  soUnidadeHospitalar?: boolean;
  descricao: string;
  fonte: string;
}

/**
 * Grupos que nunca viram sugestão de surto: violências, agravos relacionados ao trabalho e condições crônicas ou
 * congênitas, em que dois casos perto não indicam transmissão (o surto é de doença transmissível: Manual de Normas e
 * Rotinas do Sinan, 2007, Anexo A). Ficam fora das regras de quarteirão e bairro e do evento inusitado.
 */
export const GRUPOS_SEM_SUGESTAO_DE_SURTO = [
  'violencia',
  'violencia-sexual-suicidio',
  'acidente-trabalho',
  'acidente-trabalho-biologico',
  'cancer-trabalho',
  'dermatoses-ocupacionais',
  'disturbio-voz-trabalho',
  'ler-dort',
  'perda-auditiva-trabalho',
  'pneumoconioses-trabalho',
  'transtornos-mentais-trabalho',
  'aids',
  'hiv',
  'hiv-gestacao',
  'htlv',
  'htlv-gestacao',
  'sifilis',
  'hepatite-b-gestacao',
  'chagas-cronica',
  'hanseniase',
  'tuberculose',
  'anomalias-congenitas',
  'doenca-falciforme',
  'obito-infantil-materno',
];

const GVS_V1 = 'Guia de Vigilância em Saúde, 6ª ed. revisada (MS, 2024), v. 1';

/**
 * Regras padrão (configuráveis em `vigilancia.surto.regras`). Dengue, chikungunya e Zika ficam fora das regras de
 * vizinhança: o excesso delas aparece no diagrama de controle por território.
 */
export const REGRAS_SURTO_PADRAO: RegraSurto[] = [
  {
    id: 'quarteirao-7d',
    grupos: ['*'],
    excetoGrupos: ['dengue', 'chikungunya', 'zika', ...GRUPOS_SEM_SUGESTAO_DE_SURTO],
    vinculo: 'QUARTEIRAO',
    minimo: 2,
    janelaDias: 7,
    descricao: 'Dois ou mais casos do mesmo agravo no mesmo quarteirão em 7 dias',
    fonte: `${GVS_V1}: surto de DDA com 2 ou mais casos relacionados (p. 397) e definição geral de surto (p. 426); o quarteirão e a janela de 7 dias são parâmetros locais`,
  },
  {
    id: 'bairro-7d',
    grupos: ['*'],
    excetoGrupos: ['dengue', 'chikungunya', 'zika', ...GRUPOS_SEM_SUGESTAO_DE_SURTO],
    vinculo: 'BAIRRO',
    minimo: 2,
    janelaDias: 7,
    descricao: 'Dois ou mais casos do mesmo agravo no mesmo bairro em 7 dias',
    fonte: `${GVS_V1}: surto de DDA com 2 ou mais casos relacionados (p. 397) e definição geral de surto (p. 426); o bairro e a janela de 7 dias são parâmetros locais`,
  },
  {
    id: 'varicela-hospitalar',
    grupos: ['varicela'],
    vinculo: 'UNIDADE',
    minimo: 1,
    janelaDias: 21,
    soUnidadeHospitalar: true,
    descricao: 'Caso de varicela atendido em unidade hospitalar',
    fonte: `${GVS_V1}: em ambiente hospitalar, um único caso confirmado de varicela já é surto (p. 354); o surto é controlado após 21 dias sem casos novos (p. 357)`,
  },
  {
    id: 'sindrome-gripal-unidade-7d',
    grupos: ['covid'],
    vinculo: 'UNIDADE',
    minimo: 3,
    janelaDias: 7,
    descricao: 'Três ou mais casos de síndrome gripal (covid-19) na mesma unidade em 7 dias',
    fonte: `${GVS_V1}: surto de síndrome gripal com pelo menos 3 casos em ambiente fechado ou restrito e até 7 dias entre os inícios dos sintomas (p. 93)`,
  },
];

/** Caso candidato a aglomerado (notificação não descartada). Datas: `conhecidoEm` ISO; `inicioSintomas` AAAA-MM-DD. */
export interface CasoParaSurto {
  id: string;
  numero: string;
  grupo: string;
  conhecidoEm: string;
  inicioSintomas: string | null;
  blockId: string | null;
  neighborhoodId: string | null;
  unitId: string;
  unidadeHospitalar: boolean;
  /** Já ligado a surto aberto: não entra. */
  jaEmSurto: boolean;
}

export interface OpcoesDeteccaoSurto {
  /** AAAA-MM-DD. */
  hoje: string;
  /** Sugestões dispensadas: valem enquanto todos os casos foram conhecidos até `ateConhecimento` (ISO). */
  dispensas: { assinatura: string; ateConhecimento: string }[];
  /** Dias sem caso do grupo para o primeiro caso virar "evento inusitado". */
  diasInusitado: number;
  /** Último caso de cada grupo antes da janela (AAAA-MM-DD; null = nunca visto). */
  historicoPorGrupo: Record<string, string | null>;
}

/** Sugestão de surto. Assinatura = `${regra}|${vinculo}:${id}|${grupo}`. O evento inusitado usa o vínculo MUNICIPIO. */
export interface SugestaoSurto {
  assinatura: string;
  regra: string;
  descricao: string;
  grupo: string;
  vinculo: { tipo: TipoVinculoSurto | 'MUNICIPIO'; id: string };
  /** Ids das notificações. */
  casos: string[];
  primeiroSintoma: string | null;
  ultimoConhecimento: string;
  fonte: string;
}

const DIA = 86_400_000;
const dia = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
/** Data do caso para a janela: início dos sintomas; sem ele, a data (UTC) em que o caso foi conhecido. */
const dataDoCaso = (c: CasoParaSurto) => dia(c.inicioSintomas ?? c.conhecidoEm.slice(0, 10));

/**
 * Aglomerado mais recente: casos em cadeia (cada um a até `janelaDias` do anterior) com pelo menos `minimo` deles
 * dentro de uma mesma janela de `janelaDias`. A cadeia inteira entra na sugestão (o surto em curso passa da janela).
 */
function aglomeradoMaisRecente(casos: CasoParaSurto[], minimo: number, janelaDias: number): CasoParaSurto[] | null {
  const ordenados = [...casos].sort((a, b) => dataDoCaso(a) - dataDoCaso(b) || Date.parse(a.conhecidoEm) - Date.parse(b.conhecidoEm));
  const cadeias: CasoParaSurto[][] = [];
  for (const c of ordenados) {
    const ultima = cadeias[cadeias.length - 1];
    if (ultima && dataDoCaso(c) - dataDoCaso(ultima[ultima.length - 1]!) <= janelaDias * DIA) ultima.push(c);
    else cadeias.push([c]);
  }
  for (let i = cadeias.length - 1; i >= 0; i--) {
    const cadeia = cadeias[i]!;
    for (let fim = 0, ini = 0; fim < cadeia.length; fim++) {
      while (dataDoCaso(cadeia[fim]!) - dataDoCaso(cadeia[ini]!) > janelaDias * DIA) ini++;
      if (fim - ini + 1 >= Math.max(1, minimo)) return cadeia;
    }
  }
  return null;
}

function sugestao(regra: string, descricao: string, fonte: string, grupo: string, vinculo: SugestaoSurto['vinculo'], casos: CasoParaSurto[]): SugestaoSurto {
  const sintomas = casos.map((c) => c.inicioSintomas).filter((d): d is string => !!d);
  return {
    assinatura: `${regra}|${vinculo.tipo}:${vinculo.id}|${grupo}`,
    regra,
    descricao,
    grupo,
    vinculo,
    casos: casos.map((c) => c.id),
    primeiroSintoma: sintomas.length ? sintomas.reduce((a, b) => (b < a ? b : a)) : null,
    ultimoConhecimento: casos.reduce((a, c) => (Date.parse(c.conhecidoEm) > Date.parse(a.conhecidoEm) ? c : a)).conhecidoEm,
    fonte,
  };
}

/**
 * Sugestões de surto (o sistema sugere, a vigilância confirma). Casos já ligados a surto aberto não entram; uma
 * sugestão por (regra, vínculo, grupo), com o aglomerado mais recente; a dispensada volta quando aparece caso
 * conhecido depois do `ateConhecimento`. Evento inusitado: o primeiro caso de um grupo depois de `diasInusitado` dias
 * sem casos (ou nunca visto) vira sugestão própria; grupo fora de `historicoPorGrupo` não é avaliado. Casos com data
 * depois de `hoje` (erro de digitação) ficam de fora.
 */
export function detectarAglomerados(casos: CasoParaSurto[], regras: RegraSurto[], opcoes: OpcoesDeteccaoSurto): SugestaoSurto[] {
  const hoje = dia(opcoes.hoje);
  const validos = casos.filter((c) => !c.jaEmSurto && dataDoCaso(c) <= hoje);
  const porId = new Map(validos.map((c) => [c.id, c]));
  const sugestoes: SugestaoSurto[] = [];
  for (const regra of regras) {
    const grupos = new Map<string, { id: string; grupo: string; casos: CasoParaSurto[] }>();
    for (const c of validos) {
      if (!(regra.grupos.includes('*') || regra.grupos.includes(c.grupo)) || regra.excetoGrupos?.includes(c.grupo)) continue;
      if (regra.soUnidadeHospitalar && !c.unidadeHospitalar) continue;
      const id = regra.vinculo === 'QUARTEIRAO' ? c.blockId : regra.vinculo === 'BAIRRO' ? c.neighborhoodId : c.unitId;
      if (!id) continue;
      const chave = `${id}|${c.grupo}`;
      const g = grupos.get(chave) ?? { id, grupo: c.grupo, casos: [] };
      g.casos.push(c);
      grupos.set(chave, g);
    }
    for (const g of grupos.values()) {
      const aglomerado = aglomeradoMaisRecente(g.casos, regra.minimo, regra.janelaDias);
      if (aglomerado) sugestoes.push(sugestao(regra.id, regra.descricao, regra.fonte, g.grupo, { tipo: regra.vinculo, id: g.id }, aglomerado));
    }
  }
  const porGrupo = new Map<string, CasoParaSurto[]>();
  for (const c of validos) if (!GRUPOS_SEM_SUGESTAO_DE_SURTO.includes(c.grupo)) porGrupo.set(c.grupo, [...(porGrupo.get(c.grupo) ?? []), c]);
  for (const [grupo, lista] of porGrupo) {
    if (!(grupo in opcoes.historicoPorGrupo)) continue;
    const ultimo = opcoes.historicoPorGrupo[grupo] ?? null;
    const ordenados = [...lista].sort((a, b) => dataDoCaso(a) - dataDoCaso(b));
    const intervalo = ultimo === null ? Infinity : (dataDoCaso(ordenados[0]!) - dia(ultimo)) / DIA;
    if (intervalo > opcoes.diasInusitado)
      sugestoes.push(
        sugestao(
          'inusitado',
          ultimo === null ? 'Primeiro caso do agravo registrado no município: evento inusitado' : `Primeiro caso do agravo depois de ${opcoes.diasInusitado} dias sem casos: evento inusitado`,
          'Manual de Normas e Rotinas do Sinan (2007), Anexo A, p. 55: um só caso de doença transmissível ausente há muito tempo, ou nova na região, pede notificação imediata e investigação',
          grupo,
          { tipo: 'MUNICIPIO', id: 'municipio' },
          ordenados,
        ),
      );
  }
  const dispensada = (s: SugestaoSurto) => opcoes.dispensas.some((d) => d.assinatura === s.assinatura && s.casos.every((id) => Date.parse(porId.get(id)!.conhecidoEm) <= Date.parse(d.ateConhecimento)));
  return sugestoes.filter((s) => !dispensada(s)).sort((a, b) => Date.parse(b.ultimoConhecimento) - Date.parse(a.ultimoConhecimento) || a.assinatura.localeCompare(b.assinatura));
}

export type EtapaSurto = 'NOTIFICACAO' | 'INVESTIGACAO' | 'ENCERRAMENTO';

/** Campos que a validação lê (datas AAAA-MM-DD). */
export interface DadosSurtoValidacao {
  notificadoEm: string | null;
  unitId: string | null;
  grupo: string | null;
  sindrome: string | null;
  cid: string | null;
  primeirosSintomasEm: string | null;
  casos: number | null;
  localInicial: string | null;
  localInicialTexto: string | null;
  investigadoEm?: string | null;
  delimitacao?: string | null;
  delimitacaoTexto?: string | null;
  encerradoEm?: string | null;
}

/**
 * Pendências da etapa (manual 5.3.1 i): data, unidade, agravo/síndrome ou CID, primeiros sintomas do 1º caso, nº de
 * casos ≥ 1, local inicial 1-11 (texto quando 11); investigação exige DT_INVEST (não antes da notificação);
 * encerramento exige delimitação (texto quando 11) e data ≥ notificação; sintomas ≤ notificação. As etapas acumulam:
 * a investigação também confere a notificação, e o encerramento confere as duas.
 */
export function validarSurto(s: DadosSurtoValidacao, etapa: EtapaSurto): string[] {
  const erros: string[] = [];
  const data = (v: string | null | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  // Notificação (manual 5.3.1 i): campos sem os quais a notificação não entra no Sinan.
  if (!data(s.notificadoEm)) erros.push('Informe a data da notificação');
  if (!s.unitId) erros.push('Informe a unidade notificante');
  if (!s.grupo && !s.sindrome && !s.cid?.trim()) erros.push('Informe o agravo, a síndrome ou o CID do surto');
  if (!data(s.primeirosSintomasEm)) erros.push('Informe a data dos primeiros sintomas do primeiro caso');
  else if (data(s.notificadoEm) && s.primeirosSintomasEm! > s.notificadoEm!) erros.push('Os primeiros sintomas não podem ser depois da notificação');
  if (s.casos === null || !Number.isInteger(s.casos) || s.casos < 1) erros.push('Informe o número de casos suspeitos (1 ou mais)');
  if (!s.localInicial || !LOCAL_INICIAL_SURTO[s.localInicial]) erros.push('Informe o local inicial de ocorrência (1 a 11)');
  else if (s.localInicial === '11' && !s.localInicialTexto?.trim()) erros.push('Descreva o local inicial de ocorrência (Outros)');
  if (etapa === 'NOTIFICACAO') return erros;
  // Investigação: a data é obrigatória na ficha de investigação de surto.
  if (!data(s.investigadoEm)) erros.push('Informe a data da investigação');
  else if (data(s.notificadoEm) && s.investigadoEm! < s.notificadoEm!) erros.push('A investigação não pode ser antes da notificação');
  if (etapa === 'INVESTIGACAO') return erros;
  // Encerramento: delimitação do surto e data, que deve ser igual ou posterior à notificação (dicionário de surto v5).
  if (!s.delimitacao || !DELIMITACAO_SURTO[s.delimitacao]) erros.push('Informe a delimitação do surto (1 a 11)');
  else if (s.delimitacao === '11' && !s.delimitacaoTexto?.trim()) erros.push('Descreva a delimitação do surto (Outros)');
  if (!data(s.encerradoEm)) erros.push('Informe a data do encerramento');
  else if (data(s.notificadoEm) && s.encerradoEm! < s.notificadoEm!) erros.push('O encerramento não pode ser antes da notificação');
  return erros;
}
