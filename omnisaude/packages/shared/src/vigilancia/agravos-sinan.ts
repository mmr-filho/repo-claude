/**
 * Agravos dos sistemas oficiais (VIG-1c): código do agravo como vem nas exportações (ID_AGRAVO do Sinan Net e do
 * Sinan Online, CID do e-SUS), situação do caso pela classificação final de cada agravo, chave natural do registro
 * e normalização de nomes para a conciliação. Fontes: dicionários de dados do Sinan Net v5 e do Sinan Online, fichas
 * oficiais e PQA-VS 2025 (ver pesquisa da semana 27, sinan-dbf.md).
 */
import type { SistemaOficial } from './sistemas';

/** Tipo do arquivo oficial, detectado pelo conteúdo (colunas e amostra), nunca pelo nome. */
export type TipoArquivoOficial = 'NINDINET' | 'AGRAVO_NET' | 'NNEGANET' | 'NSURTNET' | 'DENGON' | 'CHIKON' | 'ESUS_NOTIFICA_CSV' | 'ESUS_SINAN_CSV' | 'TABELA_SINAN' | 'DESCONHECIDO';

export const ROTULO_TIPO_ARQUIVO: Record<TipoArquivoOficial, string> = {
  NINDINET: 'Sinan Net: notificações individuais (NINDINET)',
  AGRAVO_NET: 'Sinan Net: investigação do agravo',
  NNEGANET: 'Sinan Net: notificações negativas (NNEGANET)',
  NSURTNET: 'Sinan Net: notificações de surto (NSURTNET)',
  DENGON: 'Sinan Online: dengue (DENGON)',
  CHIKON: 'Sinan Online: chikungunya (CHIKON)',
  ESUS_NOTIFICA_CSV: 'e-SUS Notifica (CSV)',
  ESUS_SINAN_CSV: 'e-SUS Sinan (CSV)',
  TABELA_SINAN: 'Tabela auxiliar do Sinan (ignorada)',
  DESCONHECIDO: 'Arquivo não reconhecido',
};

/** Tipo do registro oficial (TP_NOT do Sinan: 2 individual, 1 negativa, 3 surto). */
export type TipoRegistroOficial = 'INDIVIDUAL' | 'NEGATIVA' | 'SURTO';

export const ROTULO_TIPO_REGISTRO: Record<TipoRegistroOficial, string> = { INDIVIDUAL: 'Individual', NEGATIVA: 'Negativa', SURTO: 'Surto' };

/** Sistema de cada tipo de arquivo (nulo: arquivo que não traz registro). */
export const SISTEMA_DO_ARQUIVO: Record<TipoArquivoOficial, SistemaOficial | null> = {
  NINDINET: 'SINAN_NET',
  AGRAVO_NET: 'SINAN_NET',
  NNEGANET: 'SINAN_NET',
  NSURTNET: 'SINAN_NET',
  DENGON: 'SINAN_ONLINE',
  CHIKON: 'SINAN_ONLINE',
  ESUS_NOTIFICA_CSV: 'ESUS_NOTIFICA',
  ESUS_SINAN_CSV: 'ESUS_SINAN',
  TABELA_SINAN: null,
  DESCONHECIDO: null,
};

/** Tipo de registro de cada tipo de arquivo (cada tipo de notificação sai num DBF próprio). */
export const TIPO_REGISTRO_DO_ARQUIVO: Record<TipoArquivoOficial, TipoRegistroOficial | null> = {
  NINDINET: 'INDIVIDUAL',
  AGRAVO_NET: 'INDIVIDUAL',
  NNEGANET: 'NEGATIVA',
  NSURTNET: 'SURTO',
  DENGON: 'INDIVIDUAL',
  CHIKON: 'INDIVIDUAL',
  ESUS_NOTIFICA_CSV: 'INDIVIDUAL',
  ESUS_SINAN_CSV: 'INDIVIDUAL',
  TABELA_SINAN: null,
  DESCONHECIDO: null,
};

/** Situação do caso, igual para o registro oficial e para a notificação do OmniSaúde. */
export type SituacaoCaso = 'CONFIRMADO' | 'DESCARTADO' | 'INCONCLUSIVO' | 'EM_INVESTIGACAO';

export const ROTULO_SITUACAO_CASO: Record<SituacaoCaso, string> = { CONFIRMADO: 'Confirmado', DESCARTADO: 'Descartado', INCONCLUSIVO: 'Inconclusivo', EM_INVESTIGACAO: 'Em investigação' };

/** Gravidade pela classificação final (dengue no Sinan Online: CLASSI_FIN 11 e 12). */
export type GravidadeCaso = 'SINAIS_ALARME' | 'GRAVE';

export const ROTULO_GRAVIDADE: Record<GravidadeCaso, string> = { SINAIS_ALARME: 'Com sinais de alarme', GRAVE: 'Grave' };

/** Códigos de CLASSI_FIN e EVOLUCAO de um agravo do Sinan (o "descartado" muda de agravo para agravo). */
export interface InfoAgravoSinan {
  /** Grupo do catálogo do OmniSaúde; nulo = agravo sem correspondência no catálogo. */
  grupo: string | null;
  nome: string;
  /** CLASSI_FIN que descartam o caso. */
  descartado: string[];
  /** CLASSI_FIN de caso inconclusivo. */
  inconclusivo: string[];
  /** CLASSI_FIN de caso grave ou com sinais de alarme. */
  graves?: Record<string, GravidadeCaso>;
  /** EVOLUCAO de óbito pelo agravo. */
  obitoAgravo: string[];
  /** EVOLUCAO de óbito em investigação. */
  obitoInvestigacao: string[];
  fonte: string;
}

const FICHA = 'Ficha do Sinan Net v5 (CID no cabeçalho)';
const ANEXO_I = 'Anexo I do dicionário da notificação individual do Sinan Net v5 (rev. nov/2018)';
const PQAVS = 'PQA-VS 2025 (PRT GM/MS nº 6.878/2025)';
const SINAN_ONLINE = 'Dicionário de dados do Sinan Online, dengue e chikungunya (rev. 21/10/2015)';
const SECUNDARIA = 'tabela de agravos de um Sinan Net de terceiros (fonte secundária: conferir com a exportação do município)';
const NAO_CONFERIDO = 'CID do cabeçalho da ficha do Sinan (não conferido na pesquisa da semana 27)';
/** Agravo sem descarte nem inconclusivo (classificação atribuída pelo sistema ou gravidade no lugar dela). */
const soConfirmado = () => ({ descartado: [] as string[], inconclusivo: [] as string[] });

/** Linha da tabela com o padrão (descartado 2, inconclusivo 8, óbito pelo agravo 2) e os ajustes do agravo. */
function linha(grupo: string | null, nome: string, fonte: string, ajuste: Partial<Omit<InfoAgravoSinan, 'grupo' | 'nome' | 'fonte'>> = {}): InfoAgravoSinan {
  return { grupo, nome, descartado: ['2'], inconclusivo: ['8'], obitoAgravo: ['2'], obitoInvestigacao: [], fonte, ...ajuste };
}

/**
 * Tabela dos agravos pelo código normalizado (sem ponto). Padrão quando não houver exceção: descartado ['2'],
 * inconclusivo ['8'] (gravado pelo sistema quando vence o prazo de encerramento), óbito pelo agravo ['2']. Os códigos
 * de CLASSI_FIN e EVOLUCAO vêm do Anexo I do dicionário; o código do agravo, das fichas oficiais e do PQA-VS 2025
 * (sinan-dbf.md A10, A12, A23 e vereditos). Grupo nulo: agravo sem correspondência no catálogo (síndromes do surto).
 * Decisões documentadas: intoxicação exógena 4 (outro diagnóstico) conta como descartado e 9 (ignorado) como
 * inconclusivo; hepatites 4 (cicatriz sorológica, infecção passada) conta como descartado; influenza por novo subtipo
 * 2 (outro agente infeccioso) conta como descartado. Agravos com classificação atribuída pelo sistema na inclusão
 * (sífilis, acidentes, doenças relacionadas ao trabalho) ou com a gravidade no lugar da classificação (animais
 * peçonhentos) não têm descarte.
 */
export const AGRAVOS_SINAN: Record<string, InfoAgravoSinan> = {
  // Arboviroses.
  A90: linha('dengue', 'Dengue', `${SINAN_ONLINE}: CLASSI_FIN 5 descartado, 10 dengue, 11 com sinais de alarme, 12 grave; CRITERIO 3 em investigação; EVOLUCAO 2 óbito pelo agravo, 4 óbito em investigação`, {
    descartado: ['5'],
    graves: { '11': 'SINAIS_ALARME', '12': 'GRAVE' },
    obitoInvestigacao: ['4'],
  }),
  A920: linha(
    'chikungunya',
    'Chikungunya',
    `${SINAN_ONLINE}: CLASSI_FIN 5 descartado, 13 chikungunya (o 8 só aparece nos registros migrados do Sinan Net); CRITERIO 3 em investigação; EVOLUCAO 2 óbito pelo agravo, 4 óbito em investigação`,
    { descartado: ['5'], obitoInvestigacao: ['4'] },
  ),
  A928: linha('zika', 'Zika', `${PQAVS}: A92.8; conclusão padrão do Sinan Net`),
  A923: linha('nilo-ocidental-arboviroses', 'Febre do Nilo Ocidental', `${PQAVS}: A92.3`),
  A959: linha('febre-amarela', 'Febre amarela', `${FICHA}: A95.9; ${ANEXO_I}: 1 silvestre, 2 urbana, 3 descartado`, { descartado: ['3'] }),
  A930: linha('oropouche', 'Febre do Oropouche', 'NT nº 117/2024-CGARB/DEDT/SVSA/MS: A93.0 no e-SUS Sinan; conclusão 1 confirmado, 2 descartado, 8 inconclusivo'),
  // Doenças da ficha individual com investigação própria.
  A279: linha('leptospirose', 'Leptospirose', `${FICHA}: A27.9; ${ANEXO_I}`),
  A379: linha('coqueluche', 'Coqueluche', `${FICHA}: A37.9; ${ANEXO_I}`),
  G039: linha('meningites', 'Meningites', `${FICHA}: G03.9 (CS_SUSPEIT 1 doença meningocócica, 2 outras; não é campo-chave); ${ANEXO_I}`),
  B09: linha('sarampo-rubeola', 'Doenças exantemáticas (sarampo e rubéola)', `${FICHA}: B09 (CS_SUSPEIT 1 sarampo, 2 rubéola; não é campo-chave); ${ANEXO_I}: 1 sarampo, 2 rubéola, 3 descartado`, {
    descartado: ['3'],
  }),
  B19: linha('hepatites-virais', 'Hepatites virais', `${FICHA}: B19; ${ANEXO_I}: 1 e 2 confirmado, 3 descartado, 4 cicatriz sorológica (contada como descartado), 8 inconclusivo`, {
    descartado: ['3', '4'],
  }),
  O981: linha('sifilis', 'Sífilis em gestante', `${FICHA}: O98.1; ${ANEXO_I}: só 1 confirmado, atribuído pelo sistema`, soConfirmado()),
  A509: linha('sifilis', 'Sífilis congênita', `${FICHA}: A50.9; ${ANEXO_I}: só 1 confirmado, atribuído pelo sistema`, soConfirmado()),
  A539: linha('sifilis', 'Sífilis adquirida', 'Ficha de notificação de SMS (A53.9; fonte secundária); classificação atribuída pelo sistema', soConfirmado()),
  A169: linha('tuberculose', 'Tuberculose', `${FICHA}: A16.9; ${ANEXO_I}: 2 descartado (mudança de diagnóstico); EVOLUCAO 3 óbito por tuberculose`, { obitoAgravo: ['3'] }),
  A309: linha('hanseniase', 'Hanseníase', `${FICHA}: A30.9; ${ANEXO_I}: 2 descartado (erro diagnóstico); EVOLUCAO 2 óbito`),
  Y09: linha('violencia', 'Violência interpessoal/autoprovocada', `${FICHA}: Y09 (ficha sem classificação final)`, soConfirmado()),
  X29: linha('acidente-animal-peconhento', 'Acidente por animais peçonhentos', `${FICHA}: X29; ${ANEXO_I}: CLASSI_FIN é a gravidade (1 leve, 2 moderado, 3 grave)`, {
    ...soConfirmado(),
    graves: { '3': 'GRAVE' },
  }),
  W64: linha('atendimento-antirrabico', 'Atendimento antirrábico humano', `${FICHA}: W64; ${ANEXO_I}: só 1 confirmado, atribuído pelo sistema`, soConfirmado()),
  T659: linha(
    'intoxicacao-exogena',
    'Intoxicação exógena',
    `${FICHA}: T65.9; ${ANEXO_I}: 1 confirmada, 2 só exposição, 3 reação adversa, 4 outro diagnóstico (contado como descartado), 5 abstinência, 9 ignorado (contado como inconclusivo); EVOLUCAO 3 óbito por intoxicação`,
    { descartado: ['4'], inconclusivo: ['9'], obitoAgravo: ['3'] },
  ),
  // Agravos do PQA-VS 2025.
  A009: linha('colera', 'Cólera', `${PQAVS}: A00.9; ${ANEXO_I}`),
  J11: linha('influenza-novo-subtipo', 'Influenza humana por novo subtipo', `${PQAVS}: J11; ${ANEXO_I}: 1 novo subtipo, 2 outro agente (contado como descartado), 3 descartado, 4 inconclusivo`, {
    descartado: ['2', '3'],
    inconclusivo: ['4'],
  }),
  A969: linha('febres-hemorragicas', 'Febre hemorrágica por arenavírus', `${PQAVS}: A96.9`),
  B54: linha('malaria', 'Malária', `${PQAVS}: B54; ${ANEXO_I}: 2 descartado (exame negativo)`),
  A209: linha('peste', 'Peste', `${PQAVS}: A20.9; ${ANEXO_I}`),
  A809: linha('polio-pfa', 'Paralisia flácida aguda/poliomielite', `${PQAVS}: A80.9; ${ANEXO_I}: 1, 2, 3 e 5 confirmado ou compatível, 4 descartado, 6 inconclusivo; EVOLUCAO 3 óbito por PFA/pólio`, {
    descartado: ['4'],
    inconclusivo: ['6'],
    obitoAgravo: ['3'],
  }),
  A829: linha('raiva-humana', 'Raiva humana', `${PQAVS}: A82.9; ${ANEXO_I}`),
  // Fonte secundária (tabela de agravos de terceiros).
  A35: linha('tetano', 'Tétano acidental', `${SECUNDARIA}; ${ANEXO_I}`),
  A33: linha('tetano', 'Tétano neonatal', `${SECUNDARIA}; ${ANEXO_I}`),
  P350: linha('rubeola-congenita', 'Síndrome da rubéola congênita', `${SECUNDARIA}; ${ANEXO_I}: 1 confirmado, 2 infecção congênita, 3 descartado, 4 inconclusivo (com interrogação no dicionário)`, {
    descartado: ['3'],
    inconclusivo: ['4'],
  }),
  O986: linha('toxoplasmose-gestacional-congenita', 'Toxoplasmose gestacional', SECUNDARIA),
  P371: linha('toxoplasmose-gestacional-congenita', 'Toxoplasmose congênita', SECUNDARIA),
  B01: linha('varicela', 'Varicela', SECUNDARIA),
  B24: linha('aids', 'Aids', `${SECUNDARIA}; ${ANEXO_I}: 2 descartado (critério 900)`),
  Z21: linha('hiv-gestacao', 'Gestante HIV', `${SECUNDARIA}; ${ANEXO_I}: só 1 confirmado, atribuído pelo sistema`, soConfirmado()),
  Z206: linha(null, 'Criança exposta ao HIV', SECUNDARIA),
  Y96: linha('acidente-trabalho', 'Acidente de trabalho grave', `${SECUNDARIA}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 5 óbito por acidente de trabalho grave`, {
    ...soConfirmado(),
    obitoAgravo: ['5'],
  }),
  Z209: linha('acidente-trabalho-biologico', 'Acidente com material biológico', `${SECUNDARIA}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 5 óbito pelo acidente`, { ...soConfirmado(), obitoAgravo: ['5'] }),
  Y59: linha('esavi', 'Evento supostamente atribuível à vacinação', `${SECUNDARIA}; o ESAVI é notificado no e-SUS Notifica`),
  // Síndromes do surto (abordagem sindrômica): sem grupo no catálogo.
  A08: linha(null, 'Síndrome diarreica aguda', `${SECUNDARIA}; não usar como regra para DTA`),
  D699: linha(null, 'Síndrome de febre hemorrágica aguda', SECUNDARIA),
  G043: linha(null, 'Síndrome neurológica aguda', SECUNDARIA),
  J07: linha(null, 'Síndrome respiratória aguda', SECUNDARIA),
  N199: linha(null, 'Síndrome da insuficiência renal aguda', SECUNDARIA),
  R17: linha(null, 'Síndrome ictérica aguda', SECUNDARIA),
  R699: linha(null, 'Outras síndromes', SECUNDARIA),
  // Demais agravos do catálogo: CID do cabeçalho da ficha, sem conferência na pesquisa.
  B550: linha('leishmaniose-visceral', 'Leishmaniose visceral', `${NAO_CONFERIDO}; ${ANEXO_I}: EVOLUCAO 3 óbito por LV`, { obitoAgravo: ['3'] }),
  B551: linha('lta', 'Leishmaniose tegumentar americana', `${NAO_CONFERIDO}; ${ANEXO_I}: 2 descartado (mudança de diagnóstico); EVOLUCAO 3 óbito por LTA`, { obitoAgravo: ['3'] }),
  B659: linha('esquistossomose', 'Esquistossomose', `${NAO_CONFERIDO}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 3 óbito por esquistossomose`, { ...soConfirmado(), obitoAgravo: ['3'] }),
  A779: linha('febre-maculosa', 'Febre maculosa', `${NAO_CONFERIDO}; ${ANEXO_I}`),
  A010: linha('febre-tifoide', 'Febre tifoide', `${NAO_CONFERIDO}; ${ANEXO_I}`),
  B334: linha('hantavirose', 'Hantavirose', `${NAO_CONFERIDO}; ${ANEXO_I}`),
  A051: linha('botulismo', 'Botulismo', `${NAO_CONFERIDO}; ${ANEXO_I}`),
  A369: linha('difteria', 'Difteria', `${NAO_CONFERIDO}; ${ANEXO_I}: EVOLUCAO 3 óbito por difteria`, { obitoAgravo: ['3'] }),
  B571: linha('chagas-aguda', 'Doença de Chagas aguda', `${NAO_CONFERIDO}; ${ANEXO_I}`),
  A810: linha('dcj', 'Doença de Creutzfeldt-Jakob', NAO_CONFERIDO),
  B04: linha('mpox', 'Mpox', `${NAO_CONFERIDO}; notificado no e-SUS Sinan`),
  B42: linha('esporotricose', 'Esporotricose humana', 'NT nº 20/2025-CGTM/DATHI/SVSA/MS: B42 no e-SUS Sinan; conclusão 1 confirmado, 2 descartado, 8 inconclusivo'),
  C80: linha('cancer-trabalho', 'Câncer relacionado ao trabalho', `${NAO_CONFERIDO}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 6 óbito pela doença`, { ...soConfirmado(), obitoAgravo: ['6'] }),
  L989: linha('dermatoses-ocupacionais', 'Dermatoses ocupacionais', `${NAO_CONFERIDO}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 6 óbito pela doença`, { ...soConfirmado(), obitoAgravo: ['6'] }),
  Z579: linha('ler-dort', 'LER/DORT', `${NAO_CONFERIDO}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 6 óbito pela doença`, { ...soConfirmado(), obitoAgravo: ['6'] }),
  H833: linha('perda-auditiva-trabalho', 'Perda auditiva induzida por ruído (PAIR)', `${NAO_CONFERIDO}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 6 óbito pela doença`, {
    ...soConfirmado(),
    obitoAgravo: ['6'],
  }),
  J64: linha('pneumoconioses-trabalho', 'Pneumoconioses relacionadas ao trabalho', `${NAO_CONFERIDO}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 6 óbito pela doença`, { ...soConfirmado(), obitoAgravo: ['6'] }),
  F99: linha('transtornos-mentais-trabalho', 'Transtornos mentais relacionados ao trabalho', `${NAO_CONFERIDO}; ${ANEXO_I}: só 1 confirmado; EVOLUCAO 6 óbito pela doença`, {
    ...soConfirmado(),
    obitoAgravo: ['6'],
  }),
};

/** Regra padrão para o agravo que não está na tabela. */
const PADRAO_SEM_TABELA = linha(null, 'Agravo sem tabela própria', ANEXO_I);

/** Agravos em que CRITERIO 3 quer dizer "em investigação" (Sinan Online e Anexo I, dengue); nos demais é "clínico". */
const CRITERIO_3_EM_INVESTIGACAO = new Set(['A90', 'A920']);

/**
 * Linha da tabela para o código (normalizado ou não): o código exato e, sem ele, os 3 primeiros caracteres (ex.:
 * 'B019' cai em 'B01'). 'A92' sozinho é ambíguo (chikungunya ou Zika) e não casa com nada.
 */
export function infoAgravoSinan(agravo: string | null | undefined): InfoAgravoSinan | null {
  const c = normalizarAgravo(agravo);
  if (!c) return null;
  return AGRAVOS_SINAN[c] ?? (c.length > 3 ? (AGRAVOS_SINAN[c.slice(0, 3)] ?? null) : null);
}

/**
 * Código do agravo normalizado: maiúsculas, sem ponto, espaço e hífen. No CHIKON (Sinan Online), 'A92', 'A92.',
 * 'A920' e 'A92.0' viram 'A920'; no DENGON, 'A90' (com ou sem ponto e subcategoria).
 */
export function normalizarAgravo(id: string | null | undefined, tipoArquivo?: TipoArquivoOficial): string | null {
  const c = (id ?? '').toUpperCase().replace(/[.\s-]+/g, '');
  if (!c) return null;
  if (tipoArquivo === 'CHIKON' && (c === 'A92' || c === 'A920')) return 'A920';
  if (tipoArquivo === 'DENGON' && /^A90\d?$/.test(c)) return 'A90';
  return c;
}

/** Código da classificação ou do critério sem espaços nem zeros à esquerda ('05' e ' 5' viram '5'). */
const codigo = (v: string | null | undefined): string => {
  const t = (v ?? '').trim();
  return /^\d+$/.test(t) ? String(Number(t)) : t;
};

/** Situação do registro oficial pela classificação final do agravo. Vazio = em investigação; CRITERIO 3 do Sinan Online também. */
export function situacaoOficial(agravo: string | null, classificacao: string | null, criterio?: string | null): SituacaoCaso {
  const classe = codigo(classificacao);
  if (!classe) return 'EM_INVESTIGACAO';
  const c = normalizarAgravo(agravo);
  if (c && CRITERIO_3_EM_INVESTIGACAO.has(c) && codigo(criterio) === '3') return 'EM_INVESTIGACAO';
  const info = infoAgravoSinan(c) ?? PADRAO_SEM_TABELA;
  if (info.descartado.includes(classe)) return 'DESCARTADO';
  if (info.inconclusivo.includes(classe)) return 'INCONCLUSIVO';
  return 'CONFIRMADO';
}

/** Gravidade do registro oficial pela classificação final (só os agravos com `graves` na tabela). */
export function gravidadeOficial(agravo: string | null, classificacao: string | null): GravidadeCaso | null {
  return infoAgravoSinan(agravo)?.graves?.[codigo(classificacao)] ?? null;
}

/**
 * Situação da notificação do OmniSaúde: finalClass 1 confirmado, 2 descartado, 8 inconclusivo, vazio em
 * investigação. A notificação DESCARTADA (rascunho descartado ou notificação anulada) conta como descartada.
 */
export function situacaoOmni(n: { status: string; finalClass: string | null }): SituacaoCaso {
  if (n.status === 'DESCARTADA') return 'DESCARTADO';
  const classe = codigo(n.finalClass);
  if (classe === '1') return 'CONFIRMADO';
  if (classe === '2') return 'DESCARTADO';
  if (classe === '8') return 'INCONCLUSIVO';
  return 'EM_INVESTIGACAO';
}

/**
 * Nome para comparar pessoas: minúsculas, sem acento, só letras e espaço simples (como o MS faz na API do e-SUS
 * Notifica). No desenho é `normalizarNome`; o nome mudou porque o território já exporta um `normalizarNome` (de
 * bairro e localidade, em maiúsculas), que continua sendo o dos apelidos de bairro.
 */
export function normalizarNomePessoa(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

/** O que a chave natural do registro oficial precisa. */
export interface DadosChaveNatural {
  sistema: SistemaOficial;
  tipo: TipoRegistroOficial;
  /** Número da notificação no sistema oficial (NU_NOTIFIC ou equivalente). */
  numero: string;
  /** Data da notificação, AAAA-MM-DD. */
  notificadoEm: string;
  /** Município de notificação (IBGE, 6 ou 7 dígitos). */
  municipio: string | null;
  /** Agravo normalizado (`normalizarAgravo`). */
  agravo: string | null;
  /** CNES da unidade notificante (a negativa não tem agravo). */
  cnes: string | null;
}

const semZeros = (numero: string) => numero.trim().replace(/^0+(?=\d)/, '');

/**
 * Chave natural do registro por sistema. Sinan Net e Sinan Online: número sem zeros à esquerda, data, município com
 * 6 dígitos e agravo (a negativa troca o agravo pelo CNES). e-SUS Sinan: número e agravo. e-SUS Notifica: número.
 */
export function chaveNatural(r: DadosChaveNatural): string {
  const numero = semZeros(r.numero);
  switch (r.sistema) {
    case 'SINAN_NET':
    case 'SINAN_ONLINE': {
      const municipio = (r.municipio ?? '').trim().slice(0, 6);
      return r.tipo === 'NEGATIVA' ? `${numero}|${r.notificadoEm}|${municipio}|${(r.cnes ?? '').trim()}` : `${numero}|${r.notificadoEm}|${municipio}|${r.agravo ?? ''}`;
    }
    case 'ESUS_SINAN':
      return `${numero}|${r.agravo ?? ''}`;
    default:
      return numero;
  }
}
