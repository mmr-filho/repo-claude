import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { brl, percentuais, valoresEmReais } from './formata';
import { SYSTEM_PROMPT } from './prompt';
import { contextoNormativo, type Corpus } from './rag';
import { chamada } from './regras';
import type { Achado, Analise, Gargalo, Parecer, Trecho } from './tipos';

/*
 * Camada 4: o agente redige o parecer a partir dos achados do motor e dos trechos do corpus. O system prompt é o da
 * especificação, literal (prompt.ts). Tudo o que o agente escreve passa por `confere`: valores em reais e
 * percentuais têm de ser os do motor ou dos trechos citados, as citações têm de estar no contexto enviado e cada
 * achado tem um bloco. O que não passa é trocado pelo texto do motor, e a troca fica registrada em `ajustes`.
 */

export const MODELO = 'claude-opus-5-5';
type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EIXOS = ['Educação', 'Saúde', 'Assistência Social'] as const;
const NIVEIS = ['Crítico', 'Alerta', 'Oportunidade'] as const;

/** JSON Schema da saída estruturada (output_config.format). Fixo: não muda de um município para outro. */
export const ESQUEMA_SAIDA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumo_executivo', 'gargalos'],
  properties: {
    resumo_executivo: { type: 'string', description: 'De 3 a 5 frases para o prefeito, com o total em jogo.' },
    gargalos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['achado_id', 'eixo', 'nivel_criticidade', 'diagnostico_direto', 'impacto_financeiro', 'base_legal', 'passo_a_passo_operacional'],
        properties: {
          achado_id: { type: 'string' },
          eixo: { type: 'string', enum: [...EIXOS] },
          nivel_criticidade: { type: 'string', enum: [...NIVEIS] },
          diagnostico_direto: { type: 'string' },
          impacto_financeiro: { type: 'string' },
          base_legal: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['trecho_id', 'citacao'],
              properties: { trecho_id: { type: 'string' }, citacao: { type: 'string' } },
            },
          },
          passo_a_passo_operacional: {
            type: 'object',
            additionalProperties: false,
            required: ['responsavel_tecnico', 'sistema_oficial', 'acao_corretiva_exata', 'prazo_competencia_limite'],
            properties: {
              responsavel_tecnico: { type: 'string' },
              sistema_oficial: { type: 'string' },
              acao_corretiva_exata: { type: 'string' },
              prazo_competencia_limite: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;

const SaidaZ = z.object({
  resumo_executivo: z.string(),
  gargalos: z.array(
    z.object({
      achado_id: z.string(),
      eixo: z.enum(EIXOS),
      nivel_criticidade: z.enum(NIVEIS),
      diagnostico_direto: z.string(),
      impacto_financeiro: z.string(),
      base_legal: z.array(z.object({ trecho_id: z.string(), citacao: z.string() })),
      passo_a_passo_operacional: z.object({
        responsavel_tecnico: z.string(),
        sistema_oficial: z.string(),
        acao_corretiva_exata: z.string(),
        prazo_competencia_limite: z.string(),
      }),
    }),
  ),
});
export type SaidaAgente = z.infer<typeof SaidaZ>;

// Instruções desta tarefa. Ficam na mensagem do usuário para o system prompt continuar literal (e em cache).
const INSTRUCOES = `Instruções desta consulta (módulo Transferências Federais do mm.api.br):
- Os gargalos já foram identificados e calculados pelo motor de regras em [DADOS_MUNICIPIO].achados. Gere exatamente um bloco por achado, na mesma ordem, com achado_id igual ao id do achado. Não crie gargalos novos; o que os dados não permitem avaliar está em "pendencias" e pode ser lembrado no resumo.
- eixo e nivel_criticidade: os do achado.
- Valores em reais e percentuais: use só os números que aparecem no achado (diagnostico, atual, parametro, impacto) ou nos trechos do contexto. Não recalcule, não some achados entre si e não arredonde de outro jeito. Quando impacto.mensal for null, diga que o valor não se reparte por mês.
- impacto.confianca "baixa" é um sinal para investigar: deixe claro que a distância até a mediana não é valor devido.
- base_legal: cite apenas trechos de [CONTEXTO_NORMATIVO_RAG], pelo trecho_id, com o dispositivo (ex.: "Lei nº 14.113/2020, art. 26"). Normas listadas em normas_externas não têm texto no contexto: mencione-as como norma a conferir, sem atribuir conteúdo a elas.
- passo_a_passo_operacional: parta de achado.passos e torne a ação mais concreta (sistema, tela ou campo) só quando tiver certeza. Prazo: use o de achado.passos; não invente datas.
- resumo_executivo: de 3 a 5 frases para o prefeito, em português claro, começando pelo que é crítico.`;

/** [DADOS_MUNICIPIO]: o que o agente precisa da análise (sem os textos das normas, que vão no contexto). */
export function dadosParaAgente(a: Analise) {
  return {
    municipio: { ibge: a.ibge, nome: a.nome, uf: 'TO', populacao: a.populacao, faixa_populacional: a.faixa },
    referencia: a.referencia,
    totais: a.totais,
    achados: a.achados.map((x) => ({
      id: x.id,
      eixo: x.eixo,
      nivel: x.nivel,
      titulo: x.titulo,
      diagnostico: x.diagnostico,
      atual: x.atual,
      parametro: x.parametro,
      impacto: { ...x.impacto, texto: impactoTexto(x) },
      base_legal: x.base_legal,
      normas_externas: x.normas_externas,
      passos: x.passos,
      fontes_dados: x.fontes_dados,
    })),
    pendencias: a.pendencias,
    receitas_federais: a.receitas_federais,
  };
}

export function contextoParaAgente(trechos: Trecho[]) {
  return trechos.map((t) => ({
    trecho_id: t.id,
    norma: t.norma,
    dispositivo: t.rotulo,
    hierarquia: t.caminho,
    ...(t.contexto ? { contexto_do_artigo: t.contexto } : {}),
    texto: t.texto,
  }));
}

export function mensagem(a: Analise, trechos: Trecho[]): string {
  return [
    INSTRUCOES,
    '[DADOS_MUNICIPIO]',
    JSON.stringify(dadosParaAgente(a), null, 1),
    '[CONTEXTO_NORMATIVO_RAG]',
    JSON.stringify(contextoParaAgente(trechos), null, 1),
  ].join('\n\n');
}

export function impactoTexto(x: Achado): string {
  const i = x.impacto;
  const mes = i.mensal !== null ? `${brl(i.mensal)} por mês (${brl(i.anual)} por ano)` : brl(i.anual);
  switch (i.natureza) {
    case 'perda_de_repasse':
      return `Repasse em risco: ${mes}.`;
    case 'ganho_potencial':
      return i.confianca === 'baixa'
        ? `Distância até a mediana dos pares: ${brl(i.anual)} por ano. É um teto teórico para orientar a investigação, não valor devido.`
        : `Ganho potencial estimado: ${mes}.`;
    case 'valor_a_aplicar':
      return i.mensal !== null
        ? `Valor a aplicar para cumprir o mínimo: ${brl(i.anual)} até dezembro (cerca de ${brl(i.mensal)} por mês).`
        : `Diferença em relação ao mínimo: ${brl(i.anual)} (exercício encerrado; o valor não se reparte por mês).`;
    case 'recurso_parado':
      return `Recurso federal parado acima da folga: ${brl(i.anual)}.`;
  }
}

function blocoDoMotor(x: Achado, trechos: Map<string, Trecho>): Gargalo {
  return {
    achado_id: x.id,
    eixo: x.eixo,
    nivel_criticidade: x.nivel,
    diagnostico_direto: x.diagnostico,
    impacto_financeiro: impactoTexto(x),
    base_legal: [
      ...x.base_legal.map((id) => ({ trecho_id: id, citacao: trechos.get(id)?.rotulo ?? id })),
      ...x.normas_externas.map((n) => ({ trecho_id: '', citacao: `${n.rotulo} (${n.observacao})` })),
    ],
    passo_a_passo_operacional: {
      responsavel_tecnico: x.passos.responsavel,
      sistema_oficial: x.passos.sistema,
      acao_corretiva_exata: x.passos.acao,
      prazo_competencia_limite: x.passos.prazo,
    },
  };
}

/** Parecer só com o texto do motor: usado sem chave da API, quando o agente falha e como referência. */
export function parecerDoMotor(a: Analise, hoje = new Date()): Parecer {
  const trechos = new Map(Object.entries(a.trechos));
  const t = a.totais;
  const resumo = a.achados.length
    ? `${a.nome}: ${t.criticos} gargalo(s) crítico(s), ${t.alertas} alerta(s) e ${t.oportunidades} oportunidade(s) nos dados abertos. ${chamada(a)}.`
    : `${a.nome}: nenhum gargalo encontrado nos dados abertos do Tesouro. Veja as pendências: há indicadores que dependem de sistemas com acesso restrito.`;
  return {
    ibge: a.ibge,
    gerado_em: hoje.toISOString(),
    origem: 'motor',
    modelo: null,
    resumo_executivo: resumo,
    gargalos: a.achados.map((x) => blocoDoMotor(x, trechos)),
    ajustes: [],
  };
}

// --- conferência do texto do agente --------------------------------------------------------------------------------
const NORMA = /\b(Lei Complementar|Lei|LC|Portaria(?: Conjunta| Interministerial)?|Resolução|Decreto)\b[^0-9]{0,40}?(\d{1,2}\.?\d{3}|\d{1,4})(?:\s*\/\s*|,\s*de\s+\d{1,2}(?:º|°)?\s+de\s+\p{L}+\s+de\s+)(\d{4})/giu;

/** "lei:14113/2020", "portaria:3493/2024": chaves das normas citadas num texto. */
export function normasCitadas(texto: string): string[] {
  return [...texto.matchAll(NORMA)].map((m) => {
    const tipo = (m[1] ?? '').toLowerCase().startsWith('lei complementar') || (m[1] ?? '') === 'LC' ? 'lc' : (m[1] ?? '').toLowerCase().split(' ')[0];
    return `${tipo}:${(m[2] ?? '').replace('.', '')}/${m[3]}`;
  });
}

/** Normas que o texto do agente pode citar pelo nome: as do contexto, as externas da regra e as do system prompt. */
function normasPermitidas(trechos: Trecho[], externas: string[]): Set<string> {
  const s = new Set<string>(['lei:14113/2020', 'portaria:3493/2024', 'lc:141/2012', 'lei:8742/1993']);
  for (const t of trechos) for (const k of normasCitadas(`${t.norma} ${t.texto} ${t.contexto ?? ''}`)) s.add(k);
  for (const e of externas) for (const k of normasCitadas(e)) s.add(k);
  return s;
}

function valoresPermitidos(x: Achado): number[] {
  const textos = [x.diagnostico, x.atual, x.parametro, x.impacto.metodo, impactoTexto(x), x.passos.acao];
  const v = [x.impacto.anual, ...(x.impacto.mensal !== null ? [x.impacto.mensal] : [])];
  for (const t of textos) for (const r of valoresEmReais(t)) v.push(r.valor);
  return v;
}

function reaisOk(texto: string, permitidos: number[]): boolean {
  return valoresEmReais(texto).every(({ valor, curto }) =>
    permitidos.some((p) => Math.abs(valor - p) <= (curto ? 0.05 * Math.abs(p) + 1 : 0.005 * Math.abs(p) + 1)),
  );
}

function percentuaisOk(texto: string, permitidos: Set<string>): boolean {
  return percentuais(texto).every((p) => permitidos.has(p.toFixed(2)));
}

function normasOk(texto: string, permitidas: Set<string>): boolean {
  return normasCitadas(texto).every((k) => permitidas.has(k));
}

/** Confere a saída do agente contra a análise e o contexto enviado; devolve o parecer final. */
export function confere(saida: SaidaAgente, a: Analise, contexto: Trecho[], modelo: string, hoje = new Date()): Parecer {
  const ajustes: string[] = [];
  const doContexto = new Map(contexto.map((t) => [t.id, t]));
  const motor = new Map(parecerDoMotor(a, hoje).gargalos.map((g) => [g.achado_id, g]));
  const porId = new Map(a.achados.map((x) => [x.id, x]));
  const pctsContexto = contexto.flatMap((t) => percentuais(`${t.texto} ${t.contexto ?? ''}`));
  const vistos = new Set<string>();
  const gargalos: Gargalo[] = [];

  for (const g of saida.gargalos) {
    const x = porId.get(g.achado_id);
    if (!x || vistos.has(g.achado_id)) {
      ajustes.push(`bloco "${g.achado_id}" removido: não corresponde a um achado do motor`);
      continue;
    }
    vistos.add(x.id);
    const ref = motor.get(x.id) as Gargalo;
    const final: Gargalo = structuredClone(g);
    if (g.eixo !== x.eixo || g.nivel_criticidade !== x.nivel) {
      ajustes.push(`${x.id}: eixo/criticidade trocados pelos do motor`);
      final.eixo = x.eixo;
      final.nivel_criticidade = x.nivel;
    }
    const reais = valoresPermitidos(x);
    const pcts = new Set([...percentuais(`${x.diagnostico} ${x.atual} ${x.parametro} ${x.impacto.metodo}`), ...pctsContexto].map((p) => p.toFixed(2)));
    const permitidas = normasPermitidas(contexto, x.normas_externas.map((n) => n.rotulo));
    const campos: [string, () => string, (v: string) => void, () => string][] = [
      ['diagnóstico', () => final.diagnostico_direto, (v) => (final.diagnostico_direto = v), () => ref.diagnostico_direto],
      ['impacto', () => final.impacto_financeiro, (v) => (final.impacto_financeiro = v), () => ref.impacto_financeiro],
      ['ação', () => final.passo_a_passo_operacional.acao_corretiva_exata, (v) => (final.passo_a_passo_operacional.acao_corretiva_exata = v), () => ref.passo_a_passo_operacional.acao_corretiva_exata],
      ['prazo', () => final.passo_a_passo_operacional.prazo_competencia_limite, (v) => (final.passo_a_passo_operacional.prazo_competencia_limite = v), () => ref.passo_a_passo_operacional.prazo_competencia_limite],
      ['sistema', () => final.passo_a_passo_operacional.sistema_oficial, (v) => (final.passo_a_passo_operacional.sistema_oficial = v), () => ref.passo_a_passo_operacional.sistema_oficial],
    ];
    for (const [nome, ler, gravar, doMotor] of campos) {
      const v = ler();
      const motivo = !reaisOk(v, reais) ? 'valor em reais que o motor não calculou'
        : !percentuaisOk(v, pcts) ? 'percentual que não está no achado nem nas normas citadas'
          : !normasOk(v, permitidas) ? 'norma fora do contexto' : '';
      if (motivo) {
        ajustes.push(`${x.id}: ${nome} trocado pelo texto do motor (${motivo})`);
        gravar(doMotor());
      }
    }
    const citacoes = g.base_legal.filter((b) => doContexto.has(b.trecho_id) && normasOk(b.citacao, permitidas));
    if (citacoes.length < g.base_legal.length) ajustes.push(`${x.id}: ${g.base_legal.length - citacoes.length} citação(ões) fora do contexto removida(s)`);
    final.base_legal = citacoes.length ? citacoes : ref.base_legal;
    if (!citacoes.length) ajustes.push(`${x.id}: base legal do motor`);
    for (const n of x.normas_externas) {
      if (!final.base_legal.some((b) => b.citacao.includes(n.rotulo))) final.base_legal.push({ trecho_id: '', citacao: `${n.rotulo} (${n.observacao})` });
    }
    gargalos.push(final);
  }
  for (const x of a.achados) {
    if (!vistos.has(x.id)) {
      ajustes.push(`${x.id}: sem bloco do agente; usado o texto do motor`);
      gargalos.push(motor.get(x.id) as Gargalo);
    }
  }
  const ordem = new Map(a.achados.map((x, i) => [x.id, i]));
  gargalos.sort((p, q) => (ordem.get(p.achado_id) ?? 0) - (ordem.get(q.achado_id) ?? 0));

  let resumo = saida.resumo_executivo;
  const todos = a.achados.flatMap(valoresPermitidos).concat(Object.values(a.totais));
  const todasNormas = normasPermitidas(contexto, a.achados.flatMap((x) => x.normas_externas.map((n) => n.rotulo)));
  if (!reaisOk(resumo, todos) || !normasOk(resumo, todasNormas)) {
    ajustes.push('resumo trocado pelo do motor (valor ou norma não conferida)');
    resumo = parecerDoMotor(a, hoje).resumo_executivo;
  }
  return { ibge: a.ibge, gerado_em: hoje.toISOString(), origem: 'agente', modelo, resumo_executivo: resumo, gargalos, ajustes };
}

// --- chamada ao modelo -------------------------------------------------------------------------------------------
export class ErroAgente extends Error {}

export interface OpcoesAgente {
  /** Cliente da API (testes passam um simulado). Sem ele, usa ANTHROPIC_API_KEY do ambiente. */
  cliente?: Pick<Anthropic, 'beta'>;
  apiKey?: string;
  modelo?: string;
  esforco?: Esforco;
  /** trechos complementares por consulta na busca BM25 */
  complementares?: number;
}

/** Parecer do agente para uma análise. Lança ErroAgente se o modelo recusar, cortar a resposta ou sair do formato. */
export async function parecer(a: Analise, corpus: Corpus, op: OpcoesAgente = {}): Promise<Parecer> {
  const contexto = contextoNormativo(a, corpus, op.complementares ?? 2);
  const cliente = op.cliente ?? new Anthropic(op.apiKey ? { apiKey: op.apiKey } : {});
  const modelo = op.modelo ?? MODELO;
  const stream = cliente.beta.messages.stream({
    model: modelo,
    max_tokens: 32000,
    // se o modelo recusar por política, o próprio servidor repete o pedido no modelo recomendado
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: op.esforco ?? 'high', format: { type: 'json_schema', schema: ESQUEMA_SAIDA } },
    // o system prompt é igual para os 139 municípios: fica em cache entre as consultas
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: mensagem(a, contexto) }],
  });
  const resposta = await stream.finalMessage();
  if (resposta.stop_reason === 'refusal') throw new ErroAgente('o modelo recusou o pedido');
  if (resposta.stop_reason === 'max_tokens') throw new ErroAgente('resposta cortada pelo limite de tokens');
  const texto = resposta.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new ErroAgente('resposta fora do formato JSON');
  }
  const saida = SaidaZ.safeParse(json);
  if (!saida.success) throw new ErroAgente(`resposta fora do esquema: ${saida.error.issues[0]?.message ?? ''}`);
  return confere(saida.data, a, contexto, resposta.model);
}
