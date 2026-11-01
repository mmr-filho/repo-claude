/**
 * Saída para os sistemas oficiais de notificação (VIG-1b). Nenhum deles tem API de escrita para terceiros: a
 * notificação confirmada no OmniSaúde entra na fila de digitação do sistema de destino e sai dela quando o
 * digitador informa o número gerado lá.
 */
export type SistemaOficial = 'SINAN_NET' | 'SINAN_ONLINE' | 'ESUS_SINAN' | 'ESUS_NOTIFICA' | 'SIVEP_GRIPE' | 'SINASC_SIM';

/** Situação da rota agravo → sistema: confirmada em nota técnica, a definir com a SES ou não confirmada para o ano. */
export type SituacaoRota = 'CONFIRMADO' | 'A_DEFINIR' | 'NAO_CONFIRMADO';

export const SISTEMA_INFO: Record<SistemaOficial, { label: string; digitacao: boolean; numero: { padrao: RegExp; dica: string } }> = {
  /** NU_NOTIFIC varchar(7), atribuído pela unidade; a chave no Sinan Net é número + data + município + agravo. */
  SINAN_NET: { label: 'Sinan Net', digitacao: true, numero: { padrao: /^\d{1,7}$/, dica: 'NU_NOTIFIC: até 7 dígitos, o número da ficha atribuído pela unidade' } },
  SINAN_ONLINE: { label: 'Sinan Online (dengue e chikungunya)', digitacao: true, numero: { padrao: /^\d{1,12}$/, dica: 'número da notificação no Sinan Online (só dígitos)' } },
  /** Dicionário de dados da notificação do e-SUS Sinan: nu_notificacao Numérico(12), UFAANNNNNNNN, gerado pelo sistema. */
  ESUS_SINAN: { label: 'e-SUS Sinan', digitacao: true, numero: { padrao: /^[1-5]\d{11}$/, dica: '12 dígitos gerados pelo e-SUS Sinan: código IBGE da UF, ano com 2 dígitos e sequencial' } },
  /** Gerado pelo sistema; o formato observado é de 12 dígitos (UF, ano e sequencial), por isso a validação é larga. */
  ESUS_NOTIFICA: { label: 'e-SUS Notifica', digitacao: true, numero: { padrao: /^\d{8,15}$/, dica: 'número gerado pelo e-SUS Notifica (em geral 12 dígitos)' } },
  /** NU_NOTIFIC do Sivep-Gripe: o 1º dígito é o tipo da ficha (3 = Srag hospitalizado); 12 dígitos até 2022, 14 nos dados de 2023 em diante. */
  SIVEP_GRIPE: { label: 'Sivep-Gripe', digitacao: true, numero: { padrao: /^(\d{12}|\d{14})$/, dica: 'número da ficha no Sivep-Gripe (12 ou 14 dígitos; na Srag hospitalizada começa com 3)' } },
  SINASC_SIM: { label: 'Declaração de nascido vivo (Sinasc) ou de óbito (SIM)', digitacao: false, numero: { padrao: /^\d{8,11}$/, dica: 'número da DNV ou da DO' } },
};

export const SITUACAO_ROTA_LABEL: Record<SituacaoRota, string> = {
  CONFIRMADO: 'Confirmado em nota técnica',
  A_DEFINIR: 'A definir com a SES',
  NAO_CONFIRMADO: 'Não confirmado para o ano',
};

export interface RotaPadrao {
  /** Grupo do agravo; com `chave`, vale só para aquela linha (subitem) do grupo. */
  grupo: string;
  chave?: string;
  sistema: SistemaOficial;
  situacao: SituacaoRota;
  fonte: string;
  nota?: string;
}

/** Vigência das rotas padrão: o ano dos atos que as fundamentam. */
export const ROTAS_VIGENTES_DESDE = '2026-01-01';

/**
 * Rotas conferidas em nota técnica (situação em 01/11/2026). O que não está aqui vai para o Sinan Net, a versão
 * vigente do Sinan. A vigilância municipal muda a rota abrindo nova vigência (a SES pode pactuar outro fluxo).
 */
export const ROTAS_PADRAO: RotaPadrao[] = [
  { grupo: 'dengue', sistema: 'SINAN_ONLINE', situacao: 'CONFIRMADO', fonte: 'NT nº 6/2026-CGFAM/DPNI/SVSA/MS; página do Sinan (gov.br): Sinan Online só para dengue e chikungunya' },
  { grupo: 'chikungunya', sistema: 'SINAN_ONLINE', situacao: 'CONFIRMADO', fonte: 'Página do Sinan (gov.br): o Sinan Online segue apenas para dengue e chikungunya' },
  { grupo: 'mpox', sistema: 'ESUS_SINAN', situacao: 'CONFIRMADO', fonte: 'Ministério da Saúde, mpox: notificação em até 24 h no e-SUS Sinan' },
  {
    grupo: 'oropouche',
    sistema: 'ESUS_SINAN',
    situacao: 'CONFIRMADO',
    fonte: 'NT nº 117/2024-CGARB/DEDT/SVSA/MS (notificação/conclusão com o CID A93.0); Página oficial do e-SUS Sinan (plataforma.saude.gov.br/esussinan): doenças notificadas pela ficha de Notificação/Conclusão',
  },
  {
    grupo: 'esporotricose',
    sistema: 'ESUS_SINAN',
    situacao: 'CONFIRMADO',
    fonte: 'NT nº 20/2025-CGTM/DATHI/SVSA/MS (campos 41, 44, 47, 48 e 54 a 56); Página oficial do e-SUS Sinan (plataforma.saude.gov.br/esussinan): doenças notificadas pela ficha de Notificação/Conclusão',
  },
  {
    grupo: 'htlv',
    sistema: 'ESUS_SINAN',
    situacao: 'CONFIRMADO',
    fonte: 'Página oficial do e-SUS Sinan (plataforma.saude.gov.br/esussinan): doenças notificadas pela ficha de Notificação/Conclusão (B33.3, Z22.6, Z20.8)',
  },
  {
    grupo: 'htlv-gestacao',
    sistema: 'ESUS_SINAN',
    situacao: 'CONFIRMADO',
    fonte: 'Página oficial do e-SUS Sinan (plataforma.saude.gov.br/esussinan): doenças notificadas pela ficha de Notificação/Conclusão (B33.3, Z22.6, Z20.8)',
  },
  {
    grupo: 'hepatite-b-gestacao',
    sistema: 'ESUS_SINAN',
    situacao: 'CONFIRMADO',
    fonte: 'Página oficial do e-SUS Sinan (plataforma.saude.gov.br/esussinan): doenças notificadas pela ficha de Notificação/Conclusão (hepatite B: Z22.8, Z20.5)',
  },
  { grupo: 'doenca-falciforme', sistema: 'ESUS_SINAN', situacao: 'CONFIRMADO', fonte: 'Página oficial do e-SUS Sinan (plataforma.saude.gov.br/esussinan): doenças notificadas pela ficha de Notificação/Conclusão (D57)' },
  {
    grupo: 'disturbio-voz-trabalho',
    sistema: 'ESUS_SINAN',
    situacao: 'CONFIRMADO',
    fonte: 'Página oficial do e-SUS Sinan (plataforma.saude.gov.br/esussinan): doenças notificadas pela ficha de Notificação/Conclusão (R49)',
  },
  { grupo: 'covid', sistema: 'ESUS_NOTIFICA', situacao: 'CONFIRMADO', fonte: 'NT nº 11/2026-CGCOVID/DEDT/SVSA/MS: SG por covid-19 confirmada no e-SUS Notifica em 24 h' },
  { grupo: 'esavi', sistema: 'ESUS_NOTIFICA', situacao: 'CONFIRMADO', fonte: 'NT nº 6/2026-CGFAM/DPNI/SVSA/MS: ESAVI e erros de imunização no e-SUS Notifica' },
  { grupo: 'srag-coronavirus', sistema: 'SIVEP_GRIPE', situacao: 'CONFIRMADO', fonte: 'NT nº 11/2026-CGCOVID/DEDT/SVSA/MS: Srag hospitalizada ou óbito por Srag no Sivep-Gripe' },
  {
    grupo: 'anomalias-congenitas',
    sistema: 'SINASC_SIM',
    situacao: 'CONFIRMADO',
    fonte: 'NT nº 3/2026-SVSA/MS: anomalias congênitas pela DNV (Sinasc, bloco VI, campo 41) e pela DO (SIM)',
    nota: 'Sem ficha no Sinan: registrar a anomalia na Declaração de Nascido Vivo (bloco VI, campo 41) ou na Declaração de Óbito. Identificada depois da DNV (até 1 ano de idade): formulário do Anexo 2 da NT nº 3/2026 à vigilância municipal (à estadual, se fora do município de nascimento), em até 7 dias (NT Conjunta nº 54/2026).',
  },
  { grupo: 'caxumba', sistema: 'SINAN_NET', situacao: 'A_DEFINIR', fonte: 'PRT GM/MS nº 11.211/2026 (item 48)', nota: 'Destino e periodicidade a definir com a SES (art. 2º, I, e Anexo divergem).' },
];

export interface RotaVigente {
  sistema: SistemaOficial;
  situacao: SituacaoRota;
  fonte: string;
  nota: string | null;
}

/** Rota da linha na data (AAAA-MM-DD): a da chave prevalece sobre a do grupo; sem rota, Sinan Net. */
export function rotaDoAgravo<R extends { groupKey: string; conditionKey: string; system: string; status: string; validFrom: string; validTo: string | null; source: string; notes: string | null }>(
  rotas: R[],
  linha: { key: string; groupKey: string },
  dia: string,
): RotaVigente {
  const vigentes = rotas.filter((r) => r.groupKey === linha.groupKey && r.validFrom <= dia && (!r.validTo || dia <= r.validTo));
  const r = vigentes.find((x) => x.conditionKey === linha.key) ?? vigentes.find((x) => x.conditionKey === '');
  if (!r) return { sistema: 'SINAN_NET', situacao: 'CONFIRMADO', fonte: 'Sinan Net, versão vigente do Sinan (padrão)', nota: null };
  return { sistema: r.system as SistemaOficial, situacao: r.status as SituacaoRota, fonte: r.source, nota: r.notes };
}

/**
 * Agravo do Sinan Net para a chave do NU_NOTIFIC (número + data + município + agravo). Difere do grupo do
 * OmniSaúde onde o Sinan tem outra divisão: as violências (interpessoal, sexual e tentativa de suicídio) são uma
 * ficha só; a sífilis tem três (adquirida, em gestante e congênita); tétano (acidental e neonatal), toxoplasmose
 * (gestacional e congênita) e sarampo/rubéola são agravos distintos. Gestante pela ficha (campo 12) ou pelo CID.
 */
export function agravoSinanDaChave(groupKey: string, code: string | null | undefined, gestante = false): string {
  const c = (code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  switch (groupKey) {
    case 'violencia':
    case 'violencia-sexual-suicidio':
      return 'violencia';
    case 'sifilis':
      return c.startsWith('A50') ? 'sifilis-congenita' : gestante || c.startsWith('O981') ? 'sifilis-gestante' : 'sifilis-adquirida';
    case 'tetano':
      return c.startsWith('A33') ? 'tetano-neonatal' : 'tetano-acidental';
    case 'toxoplasmose-gestacional-congenita':
      return c.startsWith('P371') ? 'toxoplasmose-congenita' : 'toxoplasmose-gestacional';
    case 'sarampo-rubeola':
      return c.startsWith('B06') ? 'rubeola' : 'sarampo';
    default:
      return groupKey;
  }
}

/** Número oficial informado pelo digitador: formato do sistema de destino. */
export function numeroOficialValido(sistema: SistemaOficial, numero: string): boolean {
  return SISTEMA_INFO[sistema].numero.padrao.test(numero.trim());
}

// ───────────── Investigação e encerramento (bloco "Notificação/conclusão" do Sinan Net v5) ─────────────

/** Campo 32 (CLASSI_FIN), padrão dos agravos sem ficha de investigação própria. */
export const CLASSIFICACAO_FINAL: Record<string, string> = { '1': 'Confirmado', '2': 'Descartado', '8': 'Inconclusivo' };
/** Campo 33 (CRITERIO). */
export const CRITERIO_CONFIRMACAO: Record<string, string> = { '1': 'Laboratorial', '2': 'Clínico-epidemiológico', '3': 'Clínico' };
/** Campo 41 (EVOLUCAO). */
export const EVOLUCAO_CASO: Record<string, string> = { '1': 'Cura', '2': 'Óbito pelo agravo notificado', '3': 'Óbito por outras causas', '9': 'Ignorado' };

export interface Encerramento {
  investigadaEm: string;
  classificacao: string;
  criterio: string | null;
  evolucao: string | null;
  obitoEm: string | null;
  encerradaEm: string;
}

/** Regras do dicionário de dados do Sinan Net v5 para o bloco de conclusão (campos 31 a 43). */
export function validarEncerramento(e: Encerramento, ctx: { notificadaEm: string; sintomas: string | null; hoje: string; grupo?: string }): string[] {
  const erros: string[] = [];
  const esus = usaConclusaoEsus(ctx.grupo ?? '');
  const num = numeracaoConclusao(ctx.grupo ?? '');
  if (!CLASSIFICACAO_FINAL[e.classificacao] || (esus && e.classificacao === '8')) erros.push(`Informe a classificação final (campo ${num.classificacao})`);
  if (e.investigadaEm < ctx.notificadaEm) erros.push(`A data da investigação não pode ser anterior à notificação (campo ${num.investigacao})`);
  if (e.encerradaEm < e.investigadaEm) erros.push(`A data do encerramento não pode ser anterior à investigação (campo ${num.encerramento})`);
  if (e.investigadaEm > ctx.hoje || e.encerradaEm > ctx.hoje) erros.push('Datas da investigação e do encerramento não podem ser futuras');
  // e-SUS Sinan: critério obrigatório sempre que houver classificação, só laboratorial ou clínico-epidemiológico.
  const exigeCriterio = esus ? true : e.classificacao === '1';
  if (exigeCriterio && !(e.criterio && CRITERIO_CONFIRMACAO[e.criterio] && (!esus || e.criterio !== '3'))) erros.push(`Informe o critério de confirmação/descarte (campo ${num.criterio})`);
  if (esus && !e.evolucao) erros.push(`Informe a evolução do caso (campo ${num.evolucao})`);
  if (e.evolucao && !EVOLUCAO_CASO[e.evolucao]) erros.push(`Evolução inválida (campo ${num.evolucao})`);
  if (e.evolucao === '2' && e.classificacao !== '1') erros.push(`Óbito pelo agravo só em caso confirmado (campo ${num.evolucao})`);
  if (esus && e.classificacao === '2' && e.evolucao && !['3', '9'].includes(e.evolucao)) erros.push(`Caso descartado só aceita óbito por outras causas ou ignorado (campo ${num.evolucao})`);
  if ((e.evolucao === '2' || e.evolucao === '3') && !e.obitoEm) erros.push(`Informe a data do óbito (campo ${num.obito})`);
  if (e.obitoEm && e.evolucao !== '2' && e.evolucao !== '3') erros.push(`A data do óbito só cabe com evolução para óbito (campo ${num.obito})`);
  if (e.obitoEm && ctx.sintomas && e.obitoEm < ctx.sintomas) erros.push(`A data do óbito não pode ser anterior aos primeiros sintomas (campo ${num.obito})`);
  if (e.obitoEm && e.obitoEm > ctx.hoje) erros.push('A data do óbito não pode ser futura');
  return erros;
}

// ───────────── Violência contra a mulher: comunicação à autoridade policial ─────────────

/** Grupos de violência em que a comunicação policial em 24 h se aplica à vítima mulher (Anexo V, arts. 14-A a 14-C). */
export const GRUPOS_VIOLENCIA = ['violencia', 'violencia-sexual-suicidio'] as const;
export const PRAZO_POLICIAL_HORAS = 24;

/**
 * Lesão autoprovocada (X60 a X84) não vai à polícia: o art. 14-A fala em violência interpessoal e o art. 2º, I, do
 * Anexo V separa as duas. Nenhuma norma diz isso com todas as letras (interpretação a validar com a SES).
 */
export function autoprovocada(code: string | null | undefined): boolean {
  if (!code || !/^X\d{2}/.test(code)) return false;
  const n = Number(code.slice(1, 3));
  return n >= 60 && n <= 84;
}

const eViolencia = (n: { groupKey: string; code: string | null }) => (GRUPOS_VIOLENCIA as readonly string[]).includes(n.groupKey) && !autoprovocada(n.code);

/**
 * Art. 14-A: violência interpessoal contra a mulher. O parágrafo único manda crianças e adolescentes para o ECA e
 * idosas para o Estatuto da Pessoa Idosa, então a regra das 24 h vale para mulheres de 18 a 59 anos (idade na data
 * da ciência do caso).
 */
export function exigeComunicacaoPolicial(n: { groupKey: string; code: string | null }, sexo: string, idade: number): boolean {
  return sexo === 'F' && idade >= 18 && idade < 60 && eViolencia(n);
}

/** Orientação para as vítimas fora do art. 14-A (comunicações que a lei própria exige e que o OmniSaúde não controla). */
export function orientacaoViolencia(n: { groupKey: string; code: string | null }, idade: number): string | null {
  if (!eViolencia(n)) return null;
  if (idade < 18) return 'Criança ou adolescente: comunicar o Conselho Tutelar (ECA, art. 13), sem prejuízo das outras providências legais. A comunicação policial do art. 14-A não se aplica (parágrafo único).';
  if (idade >= 60) return 'Pessoa idosa: comunicar a autoridade policial, o Ministério Público ou o Conselho do Idoso (Estatuto da Pessoa Idosa, art. 19). A regra do art. 14-A não se aplica (parágrafo único).';
  return null;
}

/**
 * Modelo da comunicação (o conteúdo é definido pela instituição: os arts. 14-D a 14-F foram revogados). Sem dados
 * que identifiquem a vítima: fora do setor saúde, a identificação só é admitida em caráter excepcional, em caso de
 * risco à comunidade ou à vítima, a juízo da autoridade sanitária e com conhecimento prévio da vítima (Lei nº
 * 10.778/2003, art. 3º, parágrafo único). Se a instituição decidir identificar, edita o modelo; o marcador
 * {paciente} só é preenchido nesse caso.
 */
export const MODELO_POLICIAL_PADRAO = [
  'Comunicação de caso de violência contra a mulher (Lei nº 10.778/2003, art. 1º, § 4º; Anexo V da PRC GM/MS nº 4/2017, arts. 14-A a 14-C)',
  'Estabelecimento: {unidade} (CNES {cnes})',
  'Data e hora do atendimento: {atendimento}',
  'Notificação: {numero}',
  'Comunicação para fins estatísticos e para as providências cabíveis, sem identificação da vítima (Lei nº 10.778/2003, art. 3º).',
].join('\n');

/** Marcadores que identificam a vítima: o PDF só os preenche quando o modelo da instituição os usa. */
export const MARCADORES_IDENTIFICACAO = ['paciente', 'nascimento', 'endereco'] as const;

// ───────────── Conclusão do e-SUS Sinan (ficha de notificação/conclusão) ─────────────

export interface CampoConclusao {
  /** Número do campo na ficha do e-SUS Sinan. */
  campo: string;
  rotulo: string;
  obrigatorio: boolean;
  /** Obrigatório só numa condição (ex.: o campo 49 no caso confirmado). */
  obrigatorioSe?: string;
  tipo: 'texto' | 'data' | 'opcao';
  opcoes?: Record<string, string>;
}

/**
 * Campos de conclusão exigidos pelas notas técnicas dos agravos notificados no e-SUS Sinan. Preenchidos a partir do
 * texto das NT (ver docs/VIGILANCIA.md); agravo sem entrada usa só o bloco genérico do Sinan Net (campos 31 a 43).
 */
const SIM_NAO_IGN = { '1': 'Sim', '2': 'Não', '9': 'Ignorado' };
const CAMPOS_NOTIFICACAO_CONCLUSAO: CampoConclusao[] = [
  { campo: '44', rotulo: 'Doenças/agravos relacionados ao trabalho', obrigatorio: true, tipo: 'opcao', opcoes: SIM_NAO_IGN },
  { campo: '45', rotulo: 'Doenças/agravos relacionados ao desastre', obrigatorio: true, tipo: 'opcao', opcoes: SIM_NAO_IGN },
  { campo: '49', rotulo: 'O caso é autóctone do município de residência?', obrigatorio: false, obrigatorioSe: 'no caso confirmado', tipo: 'opcao', opcoes: { '1': 'Sim', '2': 'Não', '3': 'Indeterminado' } },
  { campo: '50', rotulo: 'País do local provável de infecção', obrigatorio: false, tipo: 'texto' },
  { campo: '51', rotulo: 'UF do local provável de infecção', obrigatorio: false, tipo: 'texto' },
  { campo: '52', rotulo: 'Município do local provável de infecção (código IBGE)', obrigatorio: false, tipo: 'texto' },
  { campo: '53', rotulo: 'Bairro do local provável de infecção', obrigatorio: false, tipo: 'texto' },
];

/**
 * Agravos da ficha de Notificação/Conclusão do e-SUS Sinan (página oficial do sistema, ficha e modelo de informação
 * v2.0.2, de 12/06/2025). A conclusão segue a numeração da ficha: 46 investigação, 47 classificação final
 * (1 confirmado, 2 descartado; o 8 é gravado pelo sistema quando vence o prazo), 48 critério (1 laboratorial,
 * 2 clínico-epidemiológico), 54 evolução, 55 óbito e 56 data de conclusão.
 */
export const GRUPOS_ESUS_CONCLUSAO = ['esporotricose', 'oropouche', 'htlv', 'htlv-gestacao', 'hepatite-b-gestacao', 'doenca-falciforme', 'disturbio-voz-trabalho'] as const;

export const CAMPOS_CONCLUSAO_ESUS: Record<string, CampoConclusao[]> = Object.fromEntries(GRUPOS_ESUS_CONCLUSAO.map((g) => [g, CAMPOS_NOTIFICACAO_CONCLUSAO]));

export const usaConclusaoEsus = (grupo: string) => (GRUPOS_ESUS_CONCLUSAO as readonly string[]).includes(grupo);

/** Numeração do bloco de conclusão: Sinan Net v5 (campos 31 a 43 do dicionário) ou ficha do e-SUS Sinan (46 a 56). */
export function numeracaoConclusao(grupo: string) {
  return usaConclusaoEsus(grupo)
    ? { investigacao: '46', classificacao: '47', criterio: '48', evolucao: '54', obito: '55', encerramento: '56' }
    : { investigacao: '31', classificacao: '32', criterio: '33', evolucao: '41', obito: '42', encerramento: '43' };
}

/**
 * Prazos de encerramento oportuno de referência (Manual de Normas e Rotinas do Sinan, 2ª ed., 2007, item 4.5.3;
 * modelo de informação do e-SUS Sinan: Oropouche em 60 dias). Não vêm ligados: a vigilância aplica se quiser.
 * Tuberculose e hanseníase encerram com o fim do tratamento e ficam fora.
 */
export const PRAZOS_ENCERRAMENTO_REFERENCIA: { grupos: string[]; dias: number; fonte: string }[] = [
  { grupos: ['hepatites-virais', 'lta', 'leishmaniose-visceral'], dias: 180, fonte: 'Manual de Normas e Rotinas do Sinan (2007), item 4.5.3' },
  { grupos: ['oropouche'], dias: 60, fonte: 'Modelo de informação do e-SUS Sinan v2.0.2 (prazo de oportunidade)' },
];
/** Demais agravos agudos: 60 dias após a notificação (mesma fonte). */
export const PRAZO_ENCERRAMENTO_AGUDOS = 60;

export function camposDeConclusao(grupo: string): CampoConclusao[] {
  return CAMPOS_CONCLUSAO_ESUS[grupo] ?? [];
}

/** Pendências da conclusão do e-SUS Sinan (campos obrigatórios vazios ou fora das opções). */
export function validarConclusao(grupo: string, conclusao: Record<string, string | null | undefined>, classificacao?: string): string[] {
  const erros: string[] = [];
  // Campo 49 (autoctonia): obrigatório no caso confirmado.
  if (usaConclusaoEsus(grupo) && classificacao === '1' && !conclusao['49']?.toString().trim()) erros.push('Caso confirmado exige o campo 49 (O caso é autóctone do município de residência?)');
  for (const c of camposDeConclusao(grupo)) {
    const v = conclusao[c.campo]?.toString().trim();
    if (!v) {
      if (c.obrigatorio) erros.push(`Preencha o campo ${c.campo} (${c.rotulo})`);
      continue;
    }
    if (c.tipo === 'opcao' && c.opcoes && !c.opcoes[v]) erros.push(`Valor inválido no campo ${c.campo} (${c.rotulo})`);
    if (c.tipo === 'data' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) erros.push(`Data inválida no campo ${c.campo} (${c.rotulo})`);
  }
  return erros;
}
