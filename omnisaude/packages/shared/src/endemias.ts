/**
 * Controle vetorial do Aedes aegypti em campo (VIG-3a): visita do agente de combate às endemias (ACE) ao imóvel,
 * depósitos, focos, amostras, tratamento focal com baixa do larvicida por lote, pendências e a ordem de bloqueio de
 * transmissão aberta pelas notificações de dengue, chikungunya e Zika. Código compartilhado entre a API, a web e o app.
 *
 * Base: Diretrizes Nacionais para Prevenção e Controle das Arboviroses Urbanas (MS, 2025), Diretrizes Nacionais para a
 * Prevenção e Controle de Epidemias de Dengue (MS, 2009), Manual de Normas Técnicas do PNCD (FUNASA, 2001), Manual do
 * LIRAa (MS, 2013), Nota Informativa nº 29/2024-CGARB e LEDI do e-SUS APS 8.7.0. Ver docs/ENDEMIAS.md.
 */
import { distanciaM } from './territorio/geo';

// ─── Depósitos ────────────────────────────────────────────────────────────────

/** Classificação dos depósitos (Manual do LIRAa, 2013, Anexo C; reafirmada nas Diretrizes de 2025, p. 38 e 41). */
export const TIPOS_DEPOSITO = ['A1', 'A2', 'B', 'C', 'D1', 'D2', 'E'] as const;
export type TipoDeposito = (typeof TIPOS_DEPOSITO)[number];

export const DEPOSITO_INFO: Record<TipoDeposito, { grupo: string; descricao: string; tratamento: 'ULTIMA_ALTERNATIVA' | 'NAO_TRATAR' | 'SO_PONTO_ESTRATEGICO' }> = {
  A1: {
    grupo: 'Armazenamento de água para consumo',
    descricao: 'Elevado, ligado à rede pública ou a captação mecânica (poço, cisterna, mina): caixa d’água, tambor, depósito de alvenaria',
    tratamento: 'ULTIMA_ALTERNATIVA',
  },
  A2: {
    grupo: 'Armazenamento de água para consumo',
    descricao: 'Ao nível do solo, para uso doméstico: tonel, tambor, barril, tina, filtro, moringa, pote, cisterna, poço ou cacimba',
    tratamento: 'ULTIMA_ALTERNATIVA',
  },
  B: {
    grupo: 'Depósitos móveis',
    descricao: 'Vasos e frascos com água, pratos, garrafas retornáveis, pingadeiras, degelo de geladeira, bebedouros, pequenas fontes, material de construção estocado',
    tratamento: 'NAO_TRATAR',
  },
  C: {
    grupo: 'Depósitos fixos',
    descricao: 'Tanques em obras, borracharias e hortas, calhas, lajes e toldos em desnível, ralos, sanitários em desuso, piscinas não tratadas, floreiras de cemitério, cacos de vidro em muros',
    tratamento: 'ULTIMA_ALTERNATIVA',
  },
  D1: { grupo: 'Passíveis de remoção', descricao: 'Pneus e outros materiais rodantes (câmaras de ar, manchões)', tratamento: 'ULTIMA_ALTERNATIVA' },
  D2: { grupo: 'Passíveis de remoção', descricao: 'Lixo (plásticos, garrafas PET, latas), sucata e entulho de construção', tratamento: 'SO_PONTO_ESTRATEGICO' },
  E: { grupo: 'Naturais', descricao: 'Bromélias e outras axilas de folhas, buracos em árvores e rochas, restos de animais (cascas, carapaças)', tratamento: 'NAO_TRATAR' },
};

/** Contagem por tipo de depósito: inspecionados, com foco (larvas ou pupas), eliminados e tratados com larvicida. */
export interface ContagemDeposito {
  inspecionados: number;
  comFoco: number;
  eliminados: number;
  tratados: number;
}

export type Depositos = Partial<Record<TipoDeposito, ContagemDeposito>>;

export function totaisDepositos(d: Depositos | null | undefined): ContagemDeposito {
  const t: ContagemDeposito = { inspecionados: 0, comFoco: 0, eliminados: 0, tratados: 0 };
  for (const tipo of TIPOS_DEPOSITO) {
    const c = d?.[tipo];
    if (!c) continue;
    t.inspecionados += c.inspecionados;
    t.comFoco += c.comFoco;
    t.eliminados += c.eliminados;
    t.tratados += c.tratados;
  }
  return t;
}

// ─── Atividade, situação do imóvel e ciclo ────────────────────────────────────

/**
 * Atividade da visita, como nos boletins de campo do PNCD (1-LI, 2-LI+T, 3-PE, 4-T, 5-DF, 6-PVE) mais o bloqueio de
 * transmissão (boletim próprio). Um boletim por atividade; LI+T só em município infestado.
 */
export const ATIVIDADES_VETORIAIS = ['LI_T', 'LI', 'T', 'BLOQUEIO', 'PE', 'DF', 'PVE'] as const;
export type AtividadeVetorial = (typeof ATIVIDADES_VETORIAIS)[number];
export const ATIVIDADE_INFO: Record<AtividadeVetorial, { label: string; sigla: string; codigoPncd: number | null }> = {
  LI_T: { label: 'Levantamento de índice e tratamento', sigla: 'LI+T', codigoPncd: 2 },
  LI: { label: 'Levantamento de índice', sigla: 'LI', codigoPncd: 1 },
  T: { label: 'Tratamento', sigla: 'T', codigoPncd: 4 },
  BLOQUEIO: { label: 'Bloqueio de transmissão', sigla: 'BLQ', codigoPncd: null },
  PE: { label: 'Ponto estratégico', sigla: 'PE', codigoPncd: 3 },
  DF: { label: 'Delimitação de foco', sigla: 'DF', codigoPncd: 5 },
  PVE: { label: 'Pesquisa vetorial especial', sigla: 'PVE', codigoPncd: 6 },
};

/**
 * Situação do imóvel na visita. Fechado e recusado são as pendências do boletim (F e R); abandonado é o imóvel em
 * evidente desuso (Lei 13.301/2016, art. 1º, § 2º), que só entra com o rito legal. Desfecho no e-SUS: 1, 3, 2 e 3.
 */
export const SITUACOES_VISITA = ['TRABALHADO', 'FECHADO', 'RECUSADO', 'ABANDONADO'] as const;
export type SituacaoVisita = (typeof SITUACOES_VISITA)[number];
export const SITUACAO_INFO: Record<SituacaoVisita, { label: string; desfechoEsus: '1' | '2' | '3'; pendencia: boolean }> = {
  TRABALHADO: { label: 'Trabalhado', desfechoEsus: '1', pendencia: false },
  FECHADO: { label: 'Fechado', desfechoEsus: '3', pendencia: true },
  RECUSADO: { label: 'Recusado', desfechoEsus: '2', pendencia: true },
  ABANDONADO: { label: 'Abandonado / desabitado', desfechoEsus: '3', pendencia: true },
};

/** Nebulização costal (UBV portátil) no bloqueio: dentro do imóvel, no peridomicílio ou nos dois. */
export const LOCAIS_UBV = ['INTRA', 'PERI', 'INTRA_PERI'] as const;
export type LocalUbv = (typeof LOCAIS_UBV)[number];
export const LOCAL_UBV_LABEL: Record<LocalUbv, string> = { INTRA: 'Intradomicílio', PERI: 'Peridomicílio', INTRA_PERI: 'Intra e peridomicílio' };

/** Ciclo bimestral do levantamento com tratamento (6 por ano, numerados no ano civil a partir de janeiro). */
export function cicloBimestral(dataLocal: string): { ano: number; ciclo: number; chave: string; inicio: string; fim: string } {
  const ano = Number(dataLocal.slice(0, 4));
  const mes = Number(dataLocal.slice(5, 7));
  const ciclo = Math.ceil(mes / 2);
  const m1 = (ciclo - 1) * 2 + 1;
  const ultimoDia = new Date(Date.UTC(ano, m1 + 1, 0)).getUTCDate();
  const dois = (n: number) => String(n).padStart(2, '0');
  return { ano, ciclo, chave: `${ano}-${ciclo}`, inicio: `${ano}-${dois(m1)}-01`, fim: `${ano}-${dois(m1 + 1)}-${dois(ultimoDia)}` };
}

// ─── Operações registradas em campo (sem internet) ────────────────────────────

export interface AmostraCampo {
  /** Número do tubito (cada agente numera de 1 a 999 e recomeça). Um tubito por depósito positivo, nunca misturado. */
  numero: number;
  deposito: TipoDeposito;
  larvas?: number | null;
  pupas?: number | null;
}

export interface TratamentoCampo {
  produtoId: string;
  /** Lote escolhido no aparelho (do estoque baixado); sem ele, o número digitado. */
  loteId?: string | null;
  loteNumero?: string | null;
  /** Na unidade do produto (g, comprimido, unidade). */
  quantidade: number;
  /** Depósitos tratados com este produto. */
  depositos: number;
}

export interface VisitaVetorialCampo {
  atividade: AtividadeVetorial;
  situacao: SituacaoVisita;
  depositos?: Depositos | null;
  amostras?: AmostraCampo[] | null;
  tratamentos?: TratamentoCampo[] | null;
  ubv?: LocalUbv | null;
  /** Orientação ao morador sobre os criadouros (ação educativa). */
  acaoEducativa?: boolean | null;
  /** Ordem de bloqueio em execução, quando a visita faz parte dela. */
  ordemId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  precisaoGps?: number | null;
  observacoes?: string | null;
}

/** Imóvel encontrado em campo que não está no cadastro (reconhecimento geográfico, Lei 11.350/2006, art. 4º, § 1º, VI). */
export interface ImovelCampo {
  blockId: string;
  sequencia?: string | null;
  propertyType: string;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  precisaoGps?: number | null;
  observacoes?: string | null;
}

interface OperacaoBaseAce {
  /** UUID gerado no aparelho: a mesma operação enviada duas vezes é reconhecida e não duplica. */
  clientId: string;
  /** Momento do registro no aparelho (ISO 8601). */
  registradoEm: string;
  /**
   * Unidade da lotação ativa no aparelho quando o registro foi feito. O aparelho só envia na mesma lotação, e o
   * servidor recusa a operação de outra unidade (a visita, o depósito da baixa e a ficha do e-SUS são da unidade).
   */
  unitId?: string | null;
}

export type OperacaoAce =
  | (OperacaoBaseAce & { tipo: 'IMOVEL'; dados: ImovelCampo })
  | (OperacaoBaseAce & { tipo: 'VISITA_VETORIAL'; householdId?: string | null; householdClientId?: string | null; visita: VisitaVetorialCampo });

export type TipoOperacaoAce = OperacaoAce['tipo'];

export interface ResultadoSyncAce {
  clientId: string;
  tipo: TipoOperacaoAce;
  /**
   * OK e DUPLICADA: está no servidor (sai da fila). ERRO: recusada pelo conteúdo; precisa ser corrigida ou descartada.
   * TENTAR_DE_NOVO: falha passageira do servidor (conflito entre transações, banco indisponível); continua pendente
   * no aparelho e vai no próximo envio.
   */
  status: 'OK' | 'DUPLICADA' | 'ERRO' | 'TENTAR_DE_NOVO';
  id: string | null;
  erro: string | null;
  /** Gravado, mas com algo a conferir pela supervisão (ex.: larvicida sem saldo no lote, que fica pendente). */
  avisos?: string[];
}

/** Instante do registro; data ilegível vai para o fim. */
const instanteDoRegistro = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/**
 * Ordem de gravação: imóveis novos antes das visitas, cada grupo pelo instante do registro (e não pelo texto:
 * '…T14:59-03:00' é depois de '…T15:59Z'), para a visita anterior do imóvel ser gravada antes da seguinte.
 */
export function ordenarOperacoesAce<T extends { tipo: TipoOperacaoAce; registradoEm: string }>(ops: T[]): T[] {
  const ordem: Record<TipoOperacaoAce, number> = { IMOVEL: 0, VISITA_VETORIAL: 1 };
  return [...ops].sort((a, b) => ordem[a.tipo] - ordem[b.tipo] || instanteDoRegistro(a.registradoEm) - instanteDoRegistro(b.registradoEm) || a.registradoEm.localeCompare(b.registradoEm));
}

/**
 * Limites do que se registra no aparelho. A API valida cada operação com os mesmos números: o que passa na conferência
 * do aparelho não é recusado no envio.
 */
export const LIMITES_CAMPO_ACE = {
  /** Cada contagem da tabela de depósitos, larvas e pupas por tubito e depósitos tratados com cada produto. */
  contagem: 999,
  tubito: 999,
  amostras: 99,
  produtos: 5,
  /** Na unidade do produto; o estoque guarda três casas decimais (0,001 é o mínimo). */
  quantidadeMax: 100_000,
  lote: 40,
  observacaoVisita: 1000,
  observacaoImovel: 500,
  sequencia: 12,
  logradouro: 160,
  numero: 20,
  complemento: 80,
  /** Raio de incerteza da leitura do GPS, em metros. */
  precisaoGpsM: 100_000,
} as const;

/** O texto, sem os espaços das pontas, passa do limite. */
const textoPassa = (valor: string | null | undefined, max: number) => (valor?.trim().length ?? 0) > max;

function conferirGps(lat: number | null | undefined, lng: number | null | undefined, precisao: number | null | undefined): string[] {
  const erros: string[] = [];
  const fora = (n: number | null | undefined, limite: number) => n != null && !(Number.isFinite(n) && Math.abs(n) <= limite);
  if (fora(lat, 90) || fora(lng, 180)) erros.push('Posição do GPS inválida: faça nova leitura');
  if (precisao != null && !(Number.isFinite(precisao) && precisao >= 0 && precisao <= LIMITES_CAMPO_ACE.precisaoGpsM)) erros.push('Leitura do GPS sem precisão válida (acima de 100 km): faça nova leitura');
  return erros;
}

/**
 * Confere a visita antes de ir para a fila (no aparelho) e de ser gravada (na API). Devolve as mensagens de erro;
 * vazio é válido. `pontoEstrategico`: o imóvel é PE (sucata em PE pode ser tratada).
 */
export function conferirVisitaVetorial(v: VisitaVetorialCampo, opts: { pontoEstrategico?: boolean } = {}): string[] {
  const L = LIMITES_CAMPO_ACE;
  const erros: string[] = [];
  if (textoPassa(v.observacoes, L.observacaoVisita)) erros.push(`Observação com no máximo ${L.observacaoVisita} caracteres`);
  erros.push(...conferirGps(v.latitude, v.longitude, v.precisaoGps));
  const pendente = SITUACAO_INFO[v.situacao]?.pendencia ?? true;
  const d = v.depositos ?? {};
  const t = totaisDepositos(d);
  if (pendente) {
    // Nenhuma contagem (nem foco sem inspecionado): a pendência só registra que o imóvel não foi trabalhado.
    if (t.inspecionados || t.comFoco || t.eliminados || t.tratados || (v.amostras?.length ?? 0) || (v.tratamentos?.length ?? 0) || v.ubv)
      erros.push('Imóvel fechado, recusado ou abandonado não tem depósitos, amostras nem tratamento: registre só a pendência');
    return [...new Set(erros)];
  }
  for (const tipo of TIPOS_DEPOSITO) {
    const c = d[tipo];
    if (!c) continue;
    const nums = [c.inspecionados, c.comFoco, c.eliminados, c.tratados];
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 999)) {
      erros.push(`Depósito ${tipo}: use números inteiros de 0 a 999`);
      continue;
    }
    if (c.comFoco > c.inspecionados) erros.push(`Depósito ${tipo}: mais depósitos com foco do que inspecionados`);
    if (c.eliminados + c.tratados > c.inspecionados) erros.push(`Depósito ${tipo}: eliminados mais tratados passam dos inspecionados`);
    const regra = DEPOSITO_INFO[tipo].tratamento;
    if (c.tratados > 0 && (regra === 'NAO_TRATAR' || (regra === 'SO_PONTO_ESTRATEGICO' && !opts.pontoEstrategico)))
      erros.push(
        regra === 'NAO_TRATAR' ? `Depósito ${tipo} não recebe larvicida: elimine ou oriente (Manual do LIRAa, 2013)` : `Depósito ${tipo} (lixo e entulho) só recebe larvicida em ponto estratégico; fora dele, elimine`,
      );
  }
  const amostras = v.amostras ?? [];
  if (amostras.length > 99) erros.push('No máximo 99 amostras por visita');
  const numeros = new Set<number>();
  const porTipo = new Map<TipoDeposito, number>();
  for (const a of amostras) {
    if (!Number.isInteger(a.numero) || a.numero < 1 || a.numero > L.tubito) erros.push(`Número do tubito entre 1 e ${L.tubito}`);
    else if (numeros.has(a.numero)) erros.push(`Tubito ${a.numero} repetido na visita`);
    if ([a.larvas, a.pupas].some((n) => n != null && !(Number.isInteger(n) && n >= 0 && n <= L.contagem))) erros.push(`Tubito ${a.numero}: larvas e pupas de 0 a ${L.contagem}`);
    numeros.add(a.numero);
    porTipo.set(a.deposito, (porTipo.get(a.deposito) ?? 0) + 1);
  }
  for (const [tipo, n] of porTipo) if (n > (d[tipo]?.comFoco ?? 0)) erros.push(`Depósito ${tipo}: um tubito por depósito com foco (${n} tubito(s) para ${d[tipo]?.comFoco ?? 0} com foco)`);
  const tratamentos = v.tratamentos ?? [];
  if (tratamentos.length > 5) erros.push('No máximo 5 produtos por visita');
  for (const tr of tratamentos) {
    if (!(tr.quantidade > 0)) erros.push('Quantidade de larvicida maior que zero');
    // O estoque guarda três casas decimais: abaixo de 0,001 a baixa seria zero.
    else if (Math.round(tr.quantidade * 1000) < 1) erros.push('Quantidade de larvicida de pelo menos 0,001');
    else if (tr.quantidade > L.quantidadeMax) erros.push('Quantidade de larvicida de no máximo 100.000');
    if (!Number.isInteger(tr.depositos) || tr.depositos < 1) erros.push('Informe quantos depósitos receberam cada produto');
    else if (tr.depositos > L.contagem) erros.push(`Depósitos tratados com cada produto: no máximo ${L.contagem}`);
    if (!tr.loteId && !tr.loteNumero?.trim()) erros.push('Informe o lote do larvicida usado');
    else if (textoPassa(tr.loteNumero, L.lote)) erros.push(`Número do lote com no máximo ${L.lote} caracteres`);
  }
  const depositosTratados = tratamentos.reduce((s, tr) => s + (Number.isInteger(tr.depositos) ? tr.depositos : 0), 0);
  if (t.tratados !== depositosTratados)
    erros.push(
      t.tratados && !tratamentos.length
        ? 'Depósitos tratados sem o larvicida usado: informe produto, lote e quantidade'
        : `Os produtos somam ${depositosTratados} depósito(s) tratado(s), mas a tabela de depósitos tem ${t.tratados}`,
    );
  return [...new Set(erros)];
}

/**
 * Confere o imóvel novo antes de ir para a fila (no aparelho) e de ser gravado (na API), com os mesmos limites.
 * Devolve as mensagens de erro; vazio é válido.
 */
export function conferirImovelCampo(d: ImovelCampo): string[] {
  const L = LIMITES_CAMPO_ACE;
  const erros: string[] = [];
  if (!d.blockId) erros.push('Escolha o quarteirão do imóvel');
  if (!d.street?.trim() && !d.observacoes?.trim()) erros.push('Informe o logradouro ou uma referência do imóvel');
  const textos: [string | null | undefined, number, string][] = [
    [d.sequencia, L.sequencia, 'Sequência'],
    [d.street, L.logradouro, 'Logradouro'],
    [d.number, L.numero, 'Número'],
    [d.complement, L.complemento, 'Complemento'],
    [d.observacoes, L.observacaoImovel, 'Observação'],
  ];
  for (const [valor, max, nome] of textos) if (textoPassa(valor, max)) erros.push(`${nome} com no máximo ${max} caracteres`);
  erros.push(...conferirGps(d.latitude, d.longitude, d.precisaoGps));
  return erros;
}

/**
 * Motivos da ficha de visita domiciliar e territorial do e-SUS (grupo "Controle ambiental/vetorial": 34 ação educativa,
 * 35 imóvel com foco, 36 ação mecânica, 37 tratamento focal). Recusada ou ausente vai sem motivo (regra do LEDI 8.7.0);
 * realizada sem nenhum dos quatro vai como 28 (Outros), aceito também em imóvel que não é domicílio.
 */
export function motivosEsusVisitaVetorial(v: { situacao: SituacaoVisita; acaoEducativa?: boolean | null; depositos?: Depositos | null; tratamentos?: unknown[] | null; ubv?: LocalUbv | null }): string[] {
  if (SITUACAO_INFO[v.situacao].pendencia) return [];
  const t = totaisDepositos(v.depositos);
  const m: string[] = [];
  if (v.acaoEducativa) m.push('34');
  if (t.comFoco > 0) m.push('35');
  if (t.eliminados > 0) m.push('36');
  if (t.tratados > 0 || (v.tratamentos?.length ?? 0) > 0 || v.ubv) m.push('37');
  return m.length ? m : ['28'];
}

// ─── Índices larvários (preliminares: o foco ainda sem a identificação do laboratório) ─────────

export interface VisitaParaIndice {
  imovelId: string;
  situacao: SituacaoVisita;
  depositos?: Depositos | null;
}

export interface IndicesLarvarios {
  imoveisInspecionados: number;
  imoveisComFoco: number;
  depositosInspecionados: number;
  depositosComFoco: number;
  /** Índice de infestação predial: imóveis com foco ÷ imóveis inspecionados × 100. */
  iip: number | null;
  /** Índice de Breteau: depósitos com foco ÷ imóveis inspecionados × 100. */
  ib: number | null;
  /** Índice de recipientes: depósitos com foco ÷ depósitos inspecionados × 100. */
  ir: number | null;
  /** Índice por tipo de recipiente: depósitos com foco do tipo ÷ total de depósitos com foco × 100. */
  itr: Record<TipoDeposito, number | null>;
  classe: 'SATISFATORIO' | 'ALERTA' | 'RISCO' | null;
}

const umaCasa = (n: number) => Math.round(n * 10) / 10;

/** Índices do período (Manual do LIRAa, 2013, p. 19-20); cada imóvel conta uma vez, pela última visita trabalhada. */
export function indicesLarvarios(visitas: VisitaParaIndice[]): IndicesLarvarios {
  const porImovel = new Map<string, VisitaParaIndice>();
  for (const v of visitas) if (v.situacao === 'TRABALHADO') porImovel.set(v.imovelId, v);
  let imoveisComFoco = 0;
  let depositosInspecionados = 0;
  let depositosComFoco = 0;
  const focoPorTipo = Object.fromEntries(TIPOS_DEPOSITO.map((t) => [t, 0])) as Record<TipoDeposito, number>;
  for (const v of porImovel.values()) {
    const t = totaisDepositos(v.depositos);
    depositosInspecionados += t.inspecionados;
    depositosComFoco += t.comFoco;
    if (t.comFoco > 0) imoveisComFoco++;
    for (const tipo of TIPOS_DEPOSITO) focoPorTipo[tipo] += v.depositos?.[tipo]?.comFoco ?? 0;
  }
  const n = porImovel.size;
  const iip = n ? umaCasa((imoveisComFoco / n) * 100) : null;
  return {
    imoveisInspecionados: n,
    imoveisComFoco,
    depositosInspecionados,
    depositosComFoco,
    iip,
    ib: n ? umaCasa((depositosComFoco / n) * 100) : null,
    ir: depositosInspecionados ? umaCasa((depositosComFoco / depositosInspecionados) * 100) : null,
    itr: Object.fromEntries(TIPOS_DEPOSITO.map((t) => [t, depositosComFoco ? umaCasa((focoPorTipo[t] / depositosComFoco) * 100) : null])) as Record<TipoDeposito, number | null>,
    // Diretrizes de 2009 (p. 75) e Nota Informativa nº 11/2026: < 1% satisfatório, 1% a 3,9% alerta, 4% ou mais risco.
    classe: iip === null ? null : iip < 1 ? 'SATISFATORIO' : iip < 4 ? 'ALERTA' : 'RISCO',
  };
}

// ─── Ordem de bloqueio de transmissão ─────────────────────────────────────────

/** Agravos transmitidos pelo Aedes aegypti que abrem a ordem (grupos do catálogo da Lista Nacional). */
export const GRUPOS_BLOQUEIO_PADRAO = ['dengue', 'chikungunya', 'zika'] as const;

/** Casos da mesma área e do mesmo período, de até sete dias, entram numa ação só (Diretrizes de 2025, p. 52). */
export const JANELA_AGRUPAMENTO_PADRAO_DIAS = 7;

export const STATUS_ORDEM = ['AGUARDANDO_LOCALIZACAO', 'ABERTA', 'EM_CAMPO', 'CONCLUIDA', 'CANCELADA'] as const;
export type StatusOrdem = (typeof STATUS_ORDEM)[number];
export const STATUS_ORDEM_LABEL: Record<StatusOrdem, string> = {
  AGUARDANDO_LOCALIZACAO: 'Aguardando a localização da residência',
  ABERTA: 'Aberta',
  EM_CAMPO: 'Em campo',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};
export const ORDEM_ATIVA: readonly StatusOrdem[] = ['AGUARDANDO_LOCALIZACAO', 'ABERTA', 'EM_CAMPO'];

export interface CasoParaAgrupar {
  lat: number | null;
  lng: number | null;
  /** Início dos sintomas ou, sem ele, a data em que a vigilância soube do caso (AAAA-MM-DD). */
  dataReferencia: string;
  householdId?: string | null;
  patientId?: string | null;
}

const diasEntre = (a: string, b: string) => Math.abs(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86_400_000;

/**
 * Duas notificações entram na mesma ordem quando são do mesmo período (diferença entre as datas de referência de até a
 * janela, 7 dias) e as áreas do bloqueio se tocam (residências a até duas vezes o raio, 300 m com o raio de 150 m). O
 * mesmo imóvel ou a mesma pessoa no mesmo período caem na mesma ordem, mesmo sem posição; fora da janela é outra
 * transmissão (Diretrizes de 2025, p. 52: casos do mesmo período e da mesma área).
 */
export function casosAgrupam(a: CasoParaAgrupar, b: CasoParaAgrupar, raioM: number, janelaDias: number): boolean {
  if (diasEntre(a.dataReferencia, b.dataReferencia) > janelaDias) return false;
  if ((a.householdId && a.householdId === b.householdId) || (a.patientId && a.patientId === b.patientId)) return true;
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  return distanciaM([a.lng, a.lat], [b.lng, b.lat]) <= 2 * raioM;
}

/** Progresso de um quarteirão (ou da ordem toda) para a supervisão. */
export interface ProgressoBloqueio {
  imoveis: number;
  trabalhados: number;
  pendentes: number;
  semVisita: number;
  /** Trabalhados ÷ imóveis × 100. */
  cobertura: number | null;
  /** Pendentes (fechados, recusados, abandonados) ÷ imóveis × 100; a meta do PNCD é ficar abaixo de 10%. */
  pendencia: number | null;
}

export function progresso(imoveis: number, trabalhados: number, pendentes: number): ProgressoBloqueio {
  const semVisita = Math.max(0, imoveis - trabalhados - pendentes);
  return {
    imoveis,
    trabalhados,
    pendentes,
    semVisita,
    cobertura: imoveis ? umaCasa((trabalhados / imoveis) * 100) : null,
    pendencia: imoveis ? umaCasa((pendentes / imoveis) * 100) : null,
  };
}

/** Meta do PNCD (2002): pendência abaixo de 10%; acima de 20% a área é sinalizada (Diretrizes de 2009, p. 141). */
export const META_PENDENCIA = 10;
export const ALERTA_PENDENCIA = 20;
