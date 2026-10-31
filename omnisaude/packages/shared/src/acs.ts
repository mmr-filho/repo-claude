/**
 * Trabalho de campo do ACS (agente comunitário de saúde): códigos da ficha de visita domiciliar e territorial
 * do e-SUS APS (LEDI 8.7.0), operações registradas no aparelho sem internet (sincronizadas depois) e o
 * resumo de produtividade do agente. Tudo em código compartilhado entre a API, a web e o app.
 */

/** Desfecho da visita, nos códigos da ficha do e-SUS. */
export const DESFECHO_VISITA: Record<string, string> = { '1': 'Visita realizada', '2': 'Visita recusada', '3': 'Ausente' };
export type DesfechoVisita = '1' | '2' | '3';

export const TURNO_VISITA: Record<number, string> = { 1: 'Manhã', 2: 'Tarde', 3: 'Noite' };
export type TurnoVisita = 1 | 2 | 3;

/** Turno pela hora local: manhã até 12h, tarde até 18h, noite depois. */
export function turnoDaHora(hora: number): TurnoVisita {
  return hora < 12 ? 1 : hora < 18 ? 2 : 3;
}

export interface GrupoMotivos {
  titulo: string;
  motivos: { codigo: string; descricao: string }[];
}

/** Motivos da visita (códigos do LEDI), agrupados como na ficha impressa. */
export const MOTIVOS_VISITA: GrupoMotivos[] = [
  {
    titulo: 'Cadastro e acompanhamento',
    motivos: [
      { codigo: '1', descricao: 'Cadastramento / atualização' },
      { codigo: '29', descricao: 'Visita periódica' },
      { codigo: '2', descricao: 'Consulta' },
      { codigo: '3', descricao: 'Exame' },
      { codigo: '4', descricao: 'Vacina' },
      { codigo: '30', descricao: 'Condicionalidades do Bolsa Família' },
    ],
  },
  {
    titulo: 'Acompanhamento de pessoa ou condição',
    motivos: [
      { codigo: '5', descricao: 'Gestante' },
      { codigo: '6', descricao: 'Puérpera' },
      { codigo: '7', descricao: 'Recém-nascido' },
      { codigo: '8', descricao: 'Criança' },
      { codigo: '38', descricao: 'Pessoa idosa' },
      { codigo: '9', descricao: 'Pessoa com desnutrição' },
      { codigo: '10', descricao: 'Pessoa em reabilitação ou com deficiência' },
      { codigo: '11', descricao: 'Pessoa com hipertensão' },
      { codigo: '12', descricao: 'Pessoa com diabetes' },
      { codigo: '13', descricao: 'Pessoa com asma' },
      { codigo: '14', descricao: 'Pessoa com DPOC / enfisema' },
      { codigo: '15', descricao: 'Pessoa com câncer' },
      { codigo: '16', descricao: 'Pessoa com outras doenças crônicas' },
      { codigo: '17', descricao: 'Pessoa com hanseníase' },
      { codigo: '18', descricao: 'Pessoa com tuberculose' },
      { codigo: '32', descricao: 'Sintomático respiratório' },
      { codigo: '33', descricao: 'Tabagista' },
      { codigo: '19', descricao: 'Domiciliado / acamado' },
      { codigo: '20', descricao: 'Condições de vulnerabilidade social' },
      { codigo: '22', descricao: 'Saúde mental' },
      { codigo: '23', descricao: 'Usuário de álcool' },
      { codigo: '24', descricao: 'Usuário de outras drogas' },
      { codigo: '25', descricao: 'Egresso de internação' },
    ],
  },
  {
    titulo: 'Controle ambiental e vetorial',
    motivos: [
      { codigo: '35', descricao: 'Imóvel com foco' },
      { codigo: '36', descricao: 'Ação mecânica' },
      { codigo: '37', descricao: 'Tratamento focal' },
    ],
  },
  {
    titulo: 'Outros',
    motivos: [
      { codigo: '34', descricao: 'Ação educativa' },
      { codigo: '27', descricao: 'Convite para atividades coletivas / campanha de saúde' },
      { codigo: '31', descricao: 'Orientação / prevenção' },
      { codigo: '28', descricao: 'Outros' },
    ],
  },
];

export const MOTIVO_VISITA_LABEL: Record<string, string> = Object.fromEntries(MOTIVOS_VISITA.flatMap((g) => g.motivos.map((m) => [m.codigo, m.descricao])));

/** Tipo de glicemia capilar na visita (código do LEDI). */
export const TIPO_GLICEMIA: Record<string, string> = { '1': 'Jejum', '2': 'Pós-prandial', '3': 'Pré-prandial', '4': 'Não especificado' };

/** CBOs de agente comunitário de saúde e técnico de ACS (família 5151). */
export const ehCboAcs = (cbo: string | null | undefined) => /^5151/.test(cbo ?? '');

// ─── Operações registradas em campo ───────────────────────────────────────────

/** Cadastro individual mínimo feito pelo agente na porta da casa; o resto é completado na unidade. */
export interface PessoaCampo {
  name: string;
  birthDate: string;
  sex: 'M' | 'F';
  cpf?: string | null;
  cns?: string | null;
  motherName?: string | null;
  phone?: string | null;
  racaCor?: string | null;
  education?: string | null;
  nis?: string | null;
  bolsaFamilia?: boolean | null;
  /** Endereço da pessoa (normalmente o do domicílio cadastrado junto). */
  endereco?: { cep?: string | null; street?: string | null; number?: string | null; complement?: string | null; district?: string | null; city?: string | null; uf?: string | null; ibgeCode?: string | null } | null;
  /** O agente confirmou que não é a mesma pessoa de um cadastro parecido (nome e nascimento). */
  confirmarNaoDuplicado?: boolean | null;
}

/** Cadastro domiciliar (endereço e condições de moradia) nos códigos do e-SUS. */
export interface DomicilioCampo {
  cep?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  uf?: string | null;
  ibgeCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
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
  animals?: string | null;
  microArea?: string | null;
  notes?: string | null;
}

export interface VisitaCampo {
  motivos: string[];
  desfecho: DesfechoVisita;
  turno?: TurnoVisita | null;
  compartilhada?: boolean | null;
  foraDaArea?: boolean | null;
  tipoImovel?: string | null;
  microArea?: string | null;
  pesoKg?: number | null;
  alturaCm?: number | null;
  sistolica?: number | null;
  diastolica?: number | null;
  temperatura?: number | null;
  glicemia?: number | null;
  tipoGlicemia?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  observacoes?: string | null;
}

interface OperacaoBase {
  /** UUID gerado no aparelho: a mesma operação enviada duas vezes é reconhecida e não duplica. */
  clientId: string;
  /** Momento do registro no aparelho (ISO 8601), que pode ser bem anterior à sincronização. */
  registradoEm: string;
}

export type OperacaoCampo =
  | (OperacaoBase & { tipo: 'PESSOA'; patientId?: string | null; dados: PessoaCampo; familyId?: string | null; familiaClientId?: string | null; kinship?: string | null })
  | (OperacaoBase & {
      tipo: 'DOMICILIO';
      householdId?: string | null;
      dados: DomicilioCampo;
      familia?: { responsavelId?: string | null; responsavelClientId?: string | null; incomeBracket?: string | null; recordNumber?: string | null } | null;
    })
  | (OperacaoBase & { tipo: 'VISITA'; householdId?: string | null; householdClientId?: string | null; patientId?: string | null; patientClientId?: string | null; visita: VisitaCampo });

export type TipoOperacaoCampo = OperacaoCampo['tipo'];

export interface ResultadoSync {
  clientId: string;
  tipo: TipoOperacaoCampo;
  status: 'OK' | 'DUPLICADA' | 'ERRO';
  id: string | null;
  erro: string | null;
}

/** Ordem de processamento num lote: pessoas antes dos domicílios (responsável) e visitas por último. */
export const ORDEM_OPERACOES: Record<TipoOperacaoCampo, number> = { PESSOA: 0, DOMICILIO: 1, VISITA: 2 };

export function ordenarOperacoes<T extends { tipo: TipoOperacaoCampo; registradoEm: string }>(ops: T[]): T[] {
  return [...ops].sort((a, b) => ORDEM_OPERACOES[a.tipo] - ORDEM_OPERACOES[b.tipo] || a.registradoEm.localeCompare(b.registradoEm));
}

// ─── Produtividade ────────────────────────────────────────────────────────────

export interface VisitaResumo {
  professionalId: string;
  desfecho: string;
  householdId: string | null;
  patientId: string | null;
  motivos: string[];
}

export interface ProdutividadeAgente {
  professionalId: string;
  visitas: number;
  realizadas: number;
  recusadas: number;
  ausentes: number;
  domiciliosVisitados: number;
  pessoasVisitadas: number;
  /** Domicílios do território visitados ao menos uma vez no período (0 a 100). */
  cobertura: number | null;
  motivosFrequentes: { codigo: string; descricao: string; total: number }[];
}

/** Resume as visitas do período por agente; `domiciliosTerritorio` dá a cobertura (quando conhecido). */
export function resumirVisitas(visitas: VisitaResumo[], domiciliosTerritorio: Map<string, number> | number | null = null): ProdutividadeAgente[] {
  const porAgente = new Map<string, VisitaResumo[]>();
  for (const v of visitas) porAgente.set(v.professionalId, [...(porAgente.get(v.professionalId) ?? []), v]);
  return [...porAgente.entries()]
    .map(([professionalId, vs]) => {
      const realizadas = vs.filter((v) => v.desfecho === '1');
      const domicilios = new Set(realizadas.map((v) => v.householdId).filter((x): x is string => !!x));
      const pessoas = new Set(realizadas.map((v) => v.patientId).filter((x): x is string => !!x));
      const motivos = new Map<string, number>();
      for (const v of vs) for (const m of v.motivos) motivos.set(m, (motivos.get(m) ?? 0) + 1);
      const territorio = typeof domiciliosTerritorio === 'number' ? domiciliosTerritorio : (domiciliosTerritorio?.get(professionalId) ?? null);
      return {
        professionalId,
        visitas: vs.length,
        realizadas: realizadas.length,
        recusadas: vs.filter((v) => v.desfecho === '2').length,
        ausentes: vs.filter((v) => v.desfecho === '3').length,
        domiciliosVisitados: domicilios.size,
        pessoasVisitadas: pessoas.size,
        cobertura: territorio ? Math.min(100, Math.round((domicilios.size / territorio) * 1000) / 10) : null,
        motivosFrequentes: [...motivos.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([codigo, total]) => ({ codigo, descricao: MOTIVO_VISITA_LABEL[codigo] ?? codigo, total })),
      };
    })
    .sort((a, b) => b.realizadas - a.realizadas || a.professionalId.localeCompare(b.professionalId));
}
