export type ChartType = 'bar' | 'line' | 'pie' | 'table';

export interface Chart {
  type: ChartType;
  x?: string;
  y?: string;
}

export interface Column {
  name: string;
  type: 'number' | 'date' | 'datetime' | 'boolean' | 'text';
}

export interface BiResult {
  question?: string;
  explanation?: string;
  chart?: Chart;
  model?: string;
  sql: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface CatalogView {
  name: string;
  description: string;
  columns: { name: string; type: string; description?: string }[];
}

export interface PreparedQuery {
  title: string;
  description: string;
  sql: string;
  chart: Chart;
}

export const SPEC_QUESTION =
  'Gerar relação de pacientes hipertensos entre 40 e 65 anos que retiraram Hidroclorotiazida na Farmácia Central entre 01/01/2026 e 30/03/2026 e não tiveram consulta médica nos últimos 6 meses.';

export const EXAMPLE_QUESTIONS = [
  SPEC_QUESTION,
  'Quantos atendimentos de urgência por unidade nos últimos 30 dias?',
  'Distribuição das classificações de risco por cor neste mês',
  'Quais agendas tiveram mais faltas nos últimos 3 meses?',
  'Ocupação de leitos por setor hoje',
];

/** Consultas prontas sobre as views do schema bi (funcionam mesmo com a IA desativada). */
export const PREPARED: PreparedQuery[] = [
  {
    title: 'Hipertensos 40–65 anos com HCTZ e sem consulta médica há 6 meses',
    description: 'O exemplo da especificação: retirada de hidroclorotiazida na Farmácia Central entre 01/01/2026 e 30/03/2026.',
    chart: { type: 'table' },
    sql: `SELECT p.nome, p.cns, p.idade, p.sexo, p.bairro
FROM pacientes p
WHERE p.hipertenso
  AND p.idade BETWEEN 40 AND 65
  AND EXISTS (
    SELECT 1 FROM dispensacoes d
    WHERE d.paciente_id = p.id
      AND d.principio_ativo ILIKE 'hidroclorotiazida%'
      AND d.unidade = 'Farmácia Central'
      AND d.data_dispensacao >= DATE '2026-01-01'
      AND d.data_dispensacao < DATE '2026-03-31'
  )
  AND NOT EXISTS (
    SELECT 1 FROM atendimentos a
    WHERE a.paciente_id = p.id
      AND a.consulta_medica
      AND a.inicio >= now() - interval '6 months'
  )
ORDER BY p.nome`,
  },
  {
    title: 'Atendimentos por unidade (últimos 30 dias)',
    description: 'Volume de atendimentos iniciados por unidade.',
    chart: { type: 'bar', x: 'unidade', y: 'atendimentos' },
    sql: `SELECT unidade, count(*) AS atendimentos
FROM atendimentos
WHERE inicio >= now() - interval '30 days'
GROUP BY unidade
ORDER BY atendimentos DESC`,
  },
  {
    title: 'Classificações de risco por cor',
    description: 'Todas as classificações registradas.',
    chart: { type: 'pie', x: 'cor', y: 'total' },
    sql: `SELECT cor, count(*) AS total
FROM classificacoes_risco
GROUP BY cor
ORDER BY total DESC`,
  },
  {
    title: 'Ocupação de leitos por setor',
    description: 'Leitos ocupados e total por setor.',
    chart: { type: 'bar', x: 'setor', y: 'ocupados' },
    sql: `SELECT unidade, setor, count(*) FILTER (WHERE situacao = 'OCUPADO') AS ocupados, count(*) AS leitos
FROM leitos
GROUP BY unidade, setor
ORDER BY unidade, setor`,
  },
  {
    title: 'Faltas por agenda',
    description: 'Consultas com falta (no-show) por agenda.',
    chart: { type: 'bar', x: 'agenda', y: 'faltas' },
    sql: `SELECT agenda, count(*) FILTER (WHERE situacao = 'FALTOU') AS faltas, count(*) AS consultas
FROM agendamentos
GROUP BY agenda
ORDER BY faltas DESC`,
  },
  {
    title: 'Dispensações por mês',
    description: 'Quantidade dispensada por mês, todos os medicamentos.',
    chart: { type: 'line', x: 'mes', y: 'quantidade' },
    sql: `SELECT date_trunc('month', data_dispensacao)::date AS mes, sum(quantidade) AS quantidade
FROM dispensacoes
GROUP BY 1
ORDER BY 1`,
  },
];
