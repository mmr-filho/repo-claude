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

/** Situação do prazo: vencida, vencendo em até 5 dias ou no prazo. */
export function situacaoPrazo(venceEm: Date | string, agora: Date = new Date()): { situacao: SituacaoPrazo; diasRestantes: number } {
  const dias = Math.ceil((new Date(venceEm).getTime() - agora.getTime()) / DIA);
  return { situacao: dias < 0 ? 'VENCIDA' : dias <= 5 ? 'VENCE_EM_BREVE' : 'NO_PRAZO', diasRestantes: dias };
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
