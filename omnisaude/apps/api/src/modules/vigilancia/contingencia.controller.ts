import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { ContingenciaService } from './contingencia.service';

const nivel = z.enum(['MUNICIPIO', 'LOCALIDADE', 'BAIRRO']);
const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const semana = z.string().regex(/^\d{4}(0[1-9]|[1-4]\d|5[0-3])$/);
const chaveEstagio = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,29}$/);
const grupoAgravo = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{2,40}$/);
/** Campo opcional que aceita null (a tela manda null no campo vazio) e o tira da definição. */
const opcional = <T extends z.ZodTypeAny>(s: T) => s.nullish().transform((v) => v ?? undefined);

const situacaoConsulta = z.object({ nivel: nivel.optional(), territorio: z.string().uuid().optional() });
const definicaoSchema = z.object({
  estagios: z
    .array(z.object({ chave: chaveEstagio, nome: z.string().trim().min(2).max(60), ordem: z.number().int().min(0).max(20) }))
    .min(2)
    .max(10),
  agravos: z.array(grupoAgravo).min(1).max(20),
  combinacao: z.enum(['QUALQUER', 'DOIS_OU_MAIS']),
  criterios: z
    .array(
      z.object({
        id: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
        estagio: chaveEstagio,
        agravos: z.array(grupoAgravo).max(20),
        tipo: z.enum(['CANAL_ACIMA_CENTRO', 'CANAL_ENTRE_CENTRO_E_LS', 'CANAL_ACIMA_LS', 'PERCENTUAL_GRAVES', 'LETALIDADE', 'LETALIDADE_GRAVES', 'OBITOS_INVESTIGACAO_PERCENTUAL', 'INCIDENCIA_ACUMULADA', 'MANUAL']),
        descricao: z.string().trim().min(5).max(500),
        semanas: opcional(z.number().int().min(1).max(52)),
        modo: opcional(z.enum(['CONSECUTIVAS', 'K_DE_N'])),
        k: opcional(z.number().int().min(1).max(52)),
        n: opcional(z.number().int().min(1).max(52)),
        limiar: opcional(z.number().min(0).max(1_000_000)),
        comparador: opcional(z.enum(['>', '>='])),
        fonte: opcional(z.string().trim().max(300)),
      }),
    )
    .max(200),
  acoes: z
    .array(
      z.object({
        estagio: chaveEstagio,
        eixo: z.enum(['GESTAO', 'VIGILANCIA', 'LABORATORIO', 'VETORES', 'APS', 'ATENCAO_ESPECIALIZADA', 'COMUNICACAO']),
        descricao: z.string().trim().min(3).max(500),
      }),
    )
    .max(500),
  desmobilizacao: z.object({ semanas: z.number().int().min(1).max(52), descricao: z.string().trim().min(3).max(1000) }),
});
const novoPlanoSchema = z.union([
  z.object({ modelo: z.literal('MS_2025'), nome: z.string().trim().min(3).max(200).optional() }),
  z.object({ copiarDe: z.string().uuid(), nome: z.string().trim().min(3).max(200).optional() }),
]);
const editarPlanoSchema = z.object({ nome: z.string().trim().min(3).max(200).optional(), fonte: z.string().trim().max(500).nullish(), definicao: definicaoSchema });
const vigenciaSchema = z.object({ desde: dia });
const respostaSchema = z.object({
  semana,
  criterio: z.string().trim().min(1).max(40),
  atendido: z.boolean(),
  nota: z.string().trim().max(1000).nullish(),
  nivel: nivel.optional(),
  territorio: z.string().uuid().nullish(),
});
const acionarSchema = z.object({
  estagio: chaveEstagio,
  justificativa: z.string().trim().min(20).max(4000),
  ato: z.string().trim().max(300).nullish(),
  nivel: nivel.default('MUNICIPIO'),
  territorio: z.string().uuid().nullish(),
});
const acaoSchema = z
  .object({ status: z.enum(['PENDENTE', 'EM_ANDAMENTO', 'FEITA', 'NAO_SE_APLICA']).optional(), responsavel: z.string().trim().max(200).nullish(), nota: z.string().trim().max(1000).nullish() })
  .refine((v) => v.status !== undefined || v.responsavel !== undefined || v.nota !== undefined, { message: 'Nada para mudar' });

/**
 * Plano de contingência (VIG-1c, §4.2; frente F3). Leitura com `vigilancia.resumo` ou `vigilancia.painel`; escrita com
 * `vigilancia.contingencia`. O GET contingencia/planos/:id (com a definição) não estava no desenho: a tela precisa dele
 * para editar um rascunho, porque a lista traz só o resumo.
 */
@Controller('vigilancia')
export class ContingenciaController {
  constructor(private readonly contingencia: ContingenciaService) {}

  @Get('contingencia')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  situacao(@Ctx() ctx: RequestContext, @Query(zv(situacaoConsulta)) q: z.infer<typeof situacaoConsulta>) {
    return this.contingencia.situacao(ctx, q);
  }

  @Get('contingencia/planos')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  planos(@Ctx() ctx: RequestContext) {
    return this.contingencia.planos(ctx);
  }

  @Get('contingencia/planos/:id')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  plano(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.contingencia.plano(ctx, id);
  }

  @Post('contingencia/planos')
  @RequirePermission('vigilancia.contingencia')
  criarPlano(@Ctx() ctx: RequestContext, @Body(zv(novoPlanoSchema)) body: z.infer<typeof novoPlanoSchema>) {
    return this.contingencia.criarPlano(ctx, body);
  }

  @Put('contingencia/planos/:id')
  @RequirePermission('vigilancia.contingencia')
  editarPlano(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(editarPlanoSchema)) body: z.infer<typeof editarPlanoSchema>) {
    return this.contingencia.editarPlano(ctx, id, body);
  }

  @Post('contingencia/planos/:id/vigencia')
  @HttpCode(200)
  @RequirePermission('vigilancia.contingencia')
  porEmVigencia(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(vigenciaSchema)) body: z.infer<typeof vigenciaSchema>) {
    return this.contingencia.porEmVigencia(ctx, id, body);
  }

  @Post('contingencia/respostas')
  @HttpCode(200)
  @RequirePermission('vigilancia.contingencia')
  responder(@Ctx() ctx: RequestContext, @Body(zv(respostaSchema)) body: z.infer<typeof respostaSchema>) {
    return this.contingencia.responder(ctx, body);
  }

  @Post('contingencia/acionar')
  @RequirePermission('vigilancia.contingencia')
  acionar(@Ctx() ctx: RequestContext, @Body(zv(acionarSchema)) body: z.infer<typeof acionarSchema>) {
    return this.contingencia.acionar(ctx, { ...body, territorio: body.territorio ?? null });
  }

  @Patch('contingencia/acoes/:id')
  @RequirePermission('vigilancia.contingencia')
  atualizarAcao(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(acaoSchema)) body: z.infer<typeof acaoSchema>) {
    return this.contingencia.atualizarAcao(ctx, id, body);
  }
}
