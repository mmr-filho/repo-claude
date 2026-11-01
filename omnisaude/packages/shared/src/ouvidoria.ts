/**
 * Ouvidoria e pesquisa de satisfação (CID-3). Regras da Lei 13.460/2017 (defesa do usuário de serviços
 * públicos): resposta conclusiva em 30 dias, prorrogável uma única vez por igual período, com justificativa.
 */

export type TipoManifestacao = 'RECLAMACAO' | 'DENUNCIA' | 'SUGESTAO' | 'ELOGIO' | 'SOLICITACAO' | 'INFORMACAO';
export const TIPO_MANIFESTACAO: Record<TipoManifestacao, string> = {
  RECLAMACAO: 'Reclamação',
  DENUNCIA: 'Denúncia',
  SUGESTAO: 'Sugestão',
  ELOGIO: 'Elogio',
  SOLICITACAO: 'Solicitação',
  INFORMACAO: 'Pedido de informação',
};

export type CanalManifestacao = 'APP' | 'WHATSAPP' | 'PRESENCIAL' | 'TELEFONE' | 'SITE';
export const CANAL_MANIFESTACAO: Record<CanalManifestacao, string> = { APP: 'App do cidadão', WHATSAPP: 'WhatsApp', PRESENCIAL: 'Presencial', TELEFONE: 'Telefone', SITE: 'Site' };

export const ASSUNTO_MANIFESTACAO: Record<string, string> = {
  ATENDIMENTO: 'Atendimento recebido',
  TEMPO_ESPERA: 'Tempo de espera',
  AGENDAMENTO: 'Agendamento de consulta ou exame',
  MEDICAMENTO: 'Medicamentos e farmácia',
  EXAME: 'Exames e resultados',
  ESTRUTURA: 'Estrutura e limpeza da unidade',
  CONDUTA_PROFISSIONAL: 'Conduta de profissional',
  TRANSPORTE_TFD: 'Transporte e TFD',
  REGULACAO: 'Fila e regulação',
  VACINA: 'Vacinas',
  INFORMACAO: 'Informações e horários',
  OUTRO: 'Outro',
};

export type StatusManifestacao = 'RECEBIDA' | 'EM_ANALISE' | 'PRORROGADA' | 'RESPONDIDA' | 'ENCERRADA' | 'ARQUIVADA';
export const STATUS_MANIFESTACAO: Record<StatusManifestacao, string> = {
  RECEBIDA: 'Recebida',
  EM_ANALISE: 'Em análise',
  PRORROGADA: 'Prazo prorrogado',
  RESPONDIDA: 'Respondida',
  ENCERRADA: 'Encerrada',
  ARQUIVADA: 'Arquivada',
};
export const STATUS_MANIFESTACAO_ABERTA: readonly StatusManifestacao[] = ['RECEBIDA', 'EM_ANALISE', 'PRORROGADA'];

/** Lei 13.460/2017, art. 16: 30 dias, prorrogáveis uma única vez por igual período. */
export const PRAZO_RESPOSTA_DIAS = 30;
export const PRORROGACAO_DIAS = 30;
const DIA = 86_400_000;

export function numeroProtocoloOuvidoria(ano: number, sequencia: number): string {
  return `OUV-${ano}-${String(sequencia).padStart(6, '0')}`;
}

export function prazoResposta(recebidaEm: Date, dias: number = PRAZO_RESPOSTA_DIAS): Date {
  return new Date(recebidaEm.getTime() + dias * DIA);
}

export type SituacaoPrazo = 'NO_PRAZO' | 'VENCE_EM_BREVE' | 'VENCIDA';
/** A partir de quantos dias para o vencimento a manifestação entra em alerta. */
export const DIAS_ALERTA_PRAZO = 5;

/** Situação do prazo: vencida, vencendo em até 5 dias ou no prazo. */
export function situacaoPrazo(venceEm: Date | string, agora: Date = new Date()): { situacao: SituacaoPrazo; diasRestantes: number } {
  const ms = new Date(venceEm).getTime() - agora.getTime();
  // Vencida assim que passa do prazo (não só depois de um dia inteiro); dias negativos contam os dias de atraso.
  const dias = ms < 0 ? Math.floor(ms / DIA) : Math.ceil(ms / DIA);
  return { situacao: ms < 0 ? 'VENCIDA' : dias <= DIAS_ALERTA_PRAZO ? 'VENCE_EM_BREVE' : 'NO_PRAZO', diasRestantes: dias };
}

/** Faixas de vencimento em datas (para filtrar no banco com a mesma regra de situacaoPrazo). */
export function faixaPrazo(situacao: SituacaoPrazo, agora: Date = new Date()): { gte?: Date; lt?: Date } {
  const limiteAlerta = new Date(agora.getTime() + DIAS_ALERTA_PRAZO * DIA);
  if (situacao === 'VENCIDA') return { lt: agora };
  if (situacao === 'VENCE_EM_BREVE') return { gte: agora, lt: limiteAlerta };
  return { gte: limiteAlerta };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Tipo provável a partir do texto (WhatsApp): elogio, sugestão, denúncia ou reclamação. */
export function inferirTipoManifestacao(texto: string): TipoManifestacao {
  const t = norm(texto);
  if (/elogi|parabens|agradec|muito bom|excelente|otimo atendimento|adorei/.test(t)) return 'ELOGIO';
  if (/sugest|sugiro|poderia ter|seria bom se|ideia/.test(t)) return 'SUGESTAO';
  if (/denunci|assedio|agress|maus[- ]tratos|corrup|cobranca indevida|discrimina|violenc/.test(t)) return 'DENUNCIA';
  if (/informac|gostaria de saber|como faco|qual o|quando/.test(t) && !/reclam/.test(t)) return 'INFORMACAO';
  return 'RECLAMACAO';
}

const PALAVRAS_DE_ABERTURA = new Set(
  'quero queria gostaria preciso vou de da do fazer uma um uns umas registrar abrir deixar mandar enviar reclamacao reclamacoes reclamar denuncia denunciar elogio elogiar sugestao sugerir sugiro manifestacao ouvidoria anonima anonimo anonimamente por favor sobre a o as os e para na no com que me minha meu aqui'.split(
    ' ',
  ),
);

/** A mensagem traz o que aconteceu, ou só anuncia ("quero fazer uma reclamação")? */
export function manifestacaoTemConteudo(texto: string): boolean {
  const resto = norm(texto)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !PALAVRAS_DE_ABERTURA.has(w));
  return resto.join('').length >= 10;
}

/** O cidadão pediu para não ser identificado ("denúncia anônima", "sem me identificar")? */
export function pedeAnonimato(texto: string): boolean {
  return /anonim|sem (me )?identificar|nao (quero|vou) me identificar|sem (dizer|falar|informar) (o )?meu nome|sigilo/.test(norm(texto));
}

export function inferirAssuntoManifestacao(texto: string): string {
  const t = norm(texto);
  const regras: [RegExp, string][] = [
    [/esper|demora|fila|horas esperando/, 'TEMPO_ESPERA'],
    [/agend|marca|consulta|vaga/, 'AGENDAMENTO'],
    [/remedio|medicamento|farmacia|receita/, 'MEDICAMENTO'],
    [/exame|resultado|laboratorio/, 'EXAME'],
    [/limp|banheiro|sujo|estrutura|cadeira|ar[- ]condicionado|predio/, 'ESTRUTURA'],
    [/medic[oa] |enfermeir|profissional|grosseri|mal educad|destrat|atendente/, 'CONDUTA_PROFISSIONAL'],
    [/transporte|tfd|viagem|motorista|ambulancia/, 'TRANSPORTE_TFD'],
    [/regulac|encaminh|especialista/, 'REGULACAO'],
    [/vacin/, 'VACINA'],
    [/horario|telefone|endereco|informac/, 'INFORMACAO'],
    [/atendimento/, 'ATENDIMENTO'],
  ];
  for (const [re, assunto] of regras) if (re.test(t)) return assunto;
  return 'OUTRO';
}

// ───────────────────────────── Pesquisa de satisfação ─────────────────────────────

export const ESCALA_SATISFACAO: Record<number, string> = { 1: 'Muito ruim', 2: 'Ruim', 3: 'Regular', 4: 'Bom', 5: 'Ótimo' };
/** Validade da pesquisa depois do atendimento. */
export const VALIDADE_PESQUISA_DIAS = 7;

export type ClasseNps = 'PROMOTOR' | 'NEUTRO' | 'DETRATOR';
export function classificarNps(nota: number): ClasseNps {
  return nota >= 9 ? 'PROMOTOR' : nota >= 7 ? 'NEUTRO' : 'DETRATOR';
}

/** NPS clássico: % promotores − % detratores (−100 a 100); null sem respostas. */
export function calcularNps(notas: number[]): number | null {
  if (!notas.length) return null;
  const prom = notas.filter((n) => classificarNps(n) === 'PROMOTOR').length;
  const det = notas.filter((n) => classificarNps(n) === 'DETRATOR').length;
  return Math.round(((prom - det) / notas.length) * 100);
}

export interface ResumoSatisfacao {
  enviadas: number;
  respondidas: number;
  taxaResposta: number | null;
  media: number | null;
  distribuicao: Record<1 | 2 | 3 | 4 | 5, number>;
  nps: number | null;
}

export function resumoSatisfacao(pesquisas: { score: number | null; recommend: number | null }[]): ResumoSatisfacao {
  const respondidas = pesquisas.filter((p) => p.score != null);
  const distribuicao: ResumoSatisfacao['distribuicao'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const p of respondidas) distribuicao[Math.min(5, Math.max(1, Math.round(p.score!))) as 1 | 2 | 3 | 4 | 5]++;
  const soma = respondidas.reduce((a, p) => a + p.score!, 0);
  return {
    enviadas: pesquisas.length,
    respondidas: respondidas.length,
    taxaResposta: pesquisas.length ? Math.round((respondidas.length / pesquisas.length) * 100) : null,
    media: respondidas.length ? Math.round((soma / respondidas.length) * 10) / 10 : null,
    distribuicao,
    nps: calcularNps(respondidas.map((p) => p.recommend).filter((n): n is number => n != null)),
  };
}
