import { ATIVIDADES_VETORIAIS, codeIn, LIMITES_CAMPO_ACE as L, LOCAIS_UBV, SITUACOES_VISITA, TIPO_IMOVEL, TIPOS_DEPOSITO, type OperacaoAce, type TipoOperacaoAce } from '@omnisaude/shared';
import { z } from 'zod';

/**
 * Operações que o app de campo do ACE envia na sincronização. Cada uma é validada sozinha (a inválida volta ERRO e não
 * derruba as outras do lote), com os limites de LIMITES_CAMPO_ACE, os mesmos que o aparelho confere antes de enfileirar.
 */
const texto = (max: number) => z.string().trim().max(max).nullish();
const contagem = z.number().int().min(0).max(L.contagem);
const gps = {
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  precisaoGps: z.number().min(0).max(L.precisaoGpsM).nullish(),
};
const depositosSchema = z.object(Object.fromEntries(TIPOS_DEPOSITO.map((t) => [t, z.object({ inspecionados: contagem, comFoco: contagem, eliminados: contagem, tratados: contagem }).optional()]))).strict();
const base = { clientId: z.string().uuid(), registradoEm: z.string().datetime({ offset: true }), unitId: z.string().uuid().nullish() };

const imovelSchema = z.object({
  ...base,
  tipo: z.literal('IMOVEL'),
  dados: z.object({
    blockId: z.string().uuid(),
    sequencia: texto(L.sequencia),
    propertyType: z.enum(codeIn(TIPO_IMOVEL)),
    street: texto(L.logradouro),
    number: texto(L.numero),
    complement: texto(L.complemento),
    ...gps,
    observacoes: texto(L.observacaoImovel),
  }),
});

const visitaSchema = z.object({
  ...base,
  tipo: z.literal('VISITA_VETORIAL'),
  householdId: z.string().uuid().nullish(),
  householdClientId: z.string().uuid().nullish(),
  visita: z.object({
    atividade: z.enum(ATIVIDADES_VETORIAIS),
    situacao: z.enum(SITUACOES_VISITA),
    depositos: depositosSchema.nullish(),
    amostras: z
      .array(z.object({ numero: z.number().int().min(1).max(L.tubito), deposito: z.enum(TIPOS_DEPOSITO), larvas: contagem.nullish(), pupas: contagem.nullish() }))
      .max(L.amostras)
      .nullish(),
    tratamentos: z
      .array(
        z.object({
          produtoId: z.string().uuid(),
          loteId: z.string().uuid().nullish(),
          loteNumero: texto(L.lote),
          // O estoque guarda três casas decimais: abaixo de 0,001 a baixa seria zero.
          quantidade: z
            .number()
            .positive()
            .max(L.quantidadeMax)
            .refine((q) => Math.round(q * 1000) >= 1, 'use pelo menos 0,001'),
          depositos: z.number().int().min(1).max(L.contagem),
        }),
      )
      .max(L.produtos)
      .nullish(),
    ubv: z.enum(LOCAIS_UBV).nullish(),
    acaoEducativa: z.boolean().nullish(),
    ordemId: z.string().uuid().nullish(),
    ...gps,
    observacoes: texto(L.observacaoVisita),
  }),
});

export const operacaoAceSchema = z.discriminatedUnion('tipo', [imovelSchema, visitaSchema]);

// ─── Mensagens em português ───────────────────────────────────────────────────

const ROTULOS: Record<string, string> = {
  dados: 'dados do imóvel',
  visita: 'dados da visita',
  clientId: 'identificador da operação',
  registradoEm: 'data do registro',
  unitId: 'unidade',
  tipo: 'tipo da operação',
  householdId: 'imóvel',
  householdClientId: 'imóvel novo',
  blockId: 'quarteirão',
  sequencia: 'sequência',
  propertyType: 'tipo do imóvel',
  street: 'logradouro',
  number: 'número',
  complement: 'complemento',
  latitude: 'latitude',
  longitude: 'longitude',
  precisaoGps: 'precisão do GPS',
  observacoes: 'observação',
  atividade: 'atividade',
  situacao: 'situação',
  depositos: 'depósitos',
  inspecionados: 'inspecionados',
  comFoco: 'com foco',
  eliminados: 'eliminados',
  tratados: 'tratados',
  amostras: 'amostras',
  numero: 'número do tubito',
  deposito: 'depósito',
  larvas: 'larvas',
  pupas: 'pupas',
  tratamentos: 'produtos',
  produtoId: 'produto',
  loteId: 'lote',
  loteNumero: 'número do lote',
  quantidade: 'quantidade',
  ubv: 'nebulização (UBV)',
  acaoEducativa: 'ação educativa',
  ordemId: 'ordem de bloqueio',
};

const TIPO_ESPERADO: Record<string, string> = { number: 'um número', int: 'um número inteiro', string: 'um texto', boolean: 'sim ou não', object: 'um objeto', array: 'uma lista' };

/** Caminho do zod em palavras: ['visita', 'amostras', 0, 'larvas'] é "amostra 1, larvas". */
function nomeDoCampo(path: readonly PropertyKey[]): string {
  const partes: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const k = path[i];
    const prox = path[i + 1];
    if ((k === 'dados' || k === 'visita') && i < path.length - 1) continue;
    if (k === 'amostras' && typeof prox === 'number') partes.push(`amostra ${prox + 1}`);
    else if (k === 'tratamentos' && typeof prox === 'number') partes.push(`produto ${prox + 1}`);
    else if (k === 'depositos' && typeof prox === 'string') partes.push(`depósito ${prox}`);
    else {
      partes.push(typeof k === 'number' ? `item ${k + 1}` : (ROTULOS[String(k)] ?? String(k)));
      continue;
    }
    i++;
  }
  return partes.join(', ') || 'operação';
}

const numeroPtBr = (n: number | bigint) => Number(n).toLocaleString('pt-BR');

function motivo(issue: z.core.$ZodIssue, valor: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return valor === undefined ? 'obrigatório' : `esperado ${TIPO_ESPERADO[issue.expected] ?? 'outro tipo de valor'}`;
    case 'too_big':
      if (issue.origin === 'string') return `no máximo ${numeroPtBr(issue.maximum)} caracteres`;
      if (issue.origin === 'array') return `no máximo ${numeroPtBr(issue.maximum)} ${Number(issue.maximum) === 1 ? 'item' : 'itens'}`;
      return issue.inclusive ? `no máximo ${numeroPtBr(issue.maximum)}` : `menor que ${numeroPtBr(issue.maximum)}`;
    case 'too_small':
      if (issue.origin === 'string') return `no mínimo ${numeroPtBr(issue.minimum)} caracteres`;
      if (issue.origin === 'array') return `pelo menos ${numeroPtBr(issue.minimum)} ${Number(issue.minimum) === 1 ? 'item' : 'itens'}`;
      return issue.inclusive ? `no mínimo ${numeroPtBr(issue.minimum)}` : `maior que ${numeroPtBr(issue.minimum)}`;
    case 'invalid_format':
      return issue.format === 'uuid' ? 'identificador inválido' : issue.format === 'datetime' ? 'data e hora inválida (formato ISO 8601, com o fuso)' : 'formato inválido';
    case 'invalid_value':
      return `use um destes valores: ${issue.values.map(String).join(', ')}`;
    case 'invalid_union':
      return 'tipo de operação desconhecido (use IMOVEL ou VISITA_VETORIAL)';
    case 'unrecognized_keys':
      return `campo não previsto (${issue.keys.join(', ')})`;
    case 'custom':
      return issue.message;
    default:
      return 'valor inválido';
  }
}

const valorEm = (raiz: unknown, path: readonly PropertyKey[]) => path.reduce<unknown>((v, k) => (v != null && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined), raiz);

export type OperacaoValidada = { ok: true; op: OperacaoAce } | { ok: false; clientId: string; tipo: TipoOperacaoAce; erro: string };

/** Valida uma operação do lote; a inválida volta com 'Dados inválidos: <campo> — <motivo>' (até três campos). */
export function validarOperacaoAce(bruta: unknown): OperacaoValidada {
  const r = operacaoAceSchema.safeParse(bruta);
  if (r.success) return { ok: true, op: r.data as OperacaoAce };
  const porCampo = new Map<string, string>();
  for (const issue of r.error.issues) {
    const campo = nomeDoCampo(issue.path);
    if (!porCampo.has(campo)) porCampo.set(campo, motivo(issue, valorEm(bruta, issue.path)));
  }
  const partes = [...porCampo].slice(0, 3).map(([campo, m]) => `${campo} — ${m}`);
  const resto = porCampo.size > 3 ? ` (e mais ${porCampo.size - 3})` : '';
  const x = (bruta ?? {}) as { clientId?: unknown; tipo?: unknown };
  return { ok: false, clientId: typeof x.clientId === 'string' ? x.clientId : '', tipo: x.tipo === 'IMOVEL' ? 'IMOVEL' : 'VISITA_VETORIAL', erro: `Dados inválidos: ${partes.join('; ')}${resto}` };
}
