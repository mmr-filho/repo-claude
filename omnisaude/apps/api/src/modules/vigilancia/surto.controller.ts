import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { SurtoService } from './surto.service';

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instante = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const texto = (max: number) => z.string().trim().max(max);
/** CID-10 com ou sem ponto (A05.9, A059, J06); o serviço guarda sem ponto. */
const cid = z
  .string()
  .trim()
  .regex(/^[A-Za-z]\d{2}(\.?\d{1,2})?$/);
const categoria = z.enum(['SINDROMICO', 'FORA_DA_LISTA', 'DA_LISTA', 'DTA']);
const grupo = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{2,40}$/);
const localSchema = z
  .object({
    municipioIbge: z
      .string()
      .regex(/^\d{6,7}$/)
      .nullable(),
    localidadeId: uuid.nullable(),
    bairroId: uuid.nullable(),
    endereco: texto(200).nullable(),
    referencia: texto(200).nullable(),
    zona: z.enum(['1', '2', '3', '9']).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
  })
  .partial();
const novoSchema = z.object({
  assinatura: texto(300).nullish(),
  casosIndicados: z
    .array(z.object({ notificationId: uuid.optional(), officialRecordId: uuid.optional() }).refine((c) => !!c.notificationId !== !!c.officialRecordId, 'Indique a notificação ou o registro oficial'))
    .max(500)
    .optional(),
  categoria,
  grupo: grupo.nullish(),
  sindrome: texto(40).nullish(),
  cid: cid.nullish(),
  agente: texto(200).nullish(),
  notificadoEm: dia,
  conhecidoEm: instante,
  esp: z.boolean().optional(),
  unitId: uuid,
  primeirosSintomasEm: dia,
  casos: z.number().int().max(1_000_000),
  localInicial: texto(2),
  localInicialTexto: texto(200).nullish(),
  local: localSchema.optional(),
});
const investigacaoSchema = z
  .object({
    investigadoEm: dia.nullable(),
    modoTransmissao: z.enum(['1', '2', '9']).nullable(),
    veiculo: z.enum(['1', '2', '3', '4', '5', '6', '9']).nullable(),
    veiculoTexto: texto(50).nullable(),
    observacoes: texto(4000).nullable(),
    investigadorNome: texto(120).nullable(),
    investigadorFuncao: texto(120).nullable(),
  })
  .partial();
/** Bloco da ficha de surto de DTA: as chaves são as variáveis do dicionário (ex.: NU_ENTR, DS_ALICAUS). */
const dtaSchema = z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,11}$/), z.union([texto(200), z.number(), z.null()])).refine((r) => Object.keys(r).length <= 120, 'Bloco de DTA com variáveis demais');
const editarSchema = z.object({
  categoria: categoria.optional(),
  grupo: grupo.nullish(),
  sindrome: texto(40).nullish(),
  cid: cid.nullish(),
  agente: texto(200).nullish(),
  notificadoEm: dia.optional(),
  esp: z.boolean().optional(),
  primeirosSintomasEm: dia.optional(),
  casos: z.number().int().max(1_000_000).optional(),
  localInicial: texto(2).optional(),
  localInicialTexto: texto(200).nullish(),
  local: localSchema.optional(),
  investigacao: investigacaoSchema.optional(),
  dta: dtaSchema.nullish(),
});
const linhaSchema = z.object({
  iniciais: texto(15).nullish(),
  sexo: z.enum(['M', 'F', 'I']).nullish(),
  idade: texto(12).nullish(),
  municipioResidencia: z
    .string()
    .regex(/^\d{6,7}$/)
    .nullish(),
  bairroId: uuid.nullish(),
  inicioSintomas: dia.nullish(),
  hospitalizado: z.boolean().nullish(),
  obito: z.boolean().nullish(),
  classificacao: z.enum(['1', '2', '3']).nullish(),
  criterio: z.enum(['1', '2', '3', '4', '5']).nullish(),
  cidFinal: cid.nullish(),
});
const casoSchema = z.union([z.object({ notificationId: uuid }).strict(), z.object({ officialRecordId: uuid }).strict(), z.object({ linha: linhaSchema }).strict()]);
const comunicacaoSchema = z.object({
  alvo: z.enum(['SMS', 'SES', 'MS']),
  canal: z.enum(['TELEFONE', 'EMAIL', 'FORMULARIO', 'PRESENCIAL', 'OUTRO']),
  contraparte: z.string().trim().min(2).max(120),
  protocolo: texto(60).nullish(),
  nota: texto(1000).nullish(),
  em: instante,
});
const encerrarSchema = z.object({ delimitacao: texto(2), texto: texto(200).nullish(), data: dia, notas: texto(4000).nullish() });
const descartarSchema = z.object({ motivo: z.string().trim().min(10).max(1000) });
const numeroSchema = z.object({ numero: z.string().trim().min(1).max(20) });
const dispensarSchema = z.object({ assinatura: z.string().trim().min(3).max(300), motivo: z.string().trim().min(10).max(1000) });
const listarSchema = z.object({ status: z.enum(['ABERTO', 'ENCERRADO', 'DESCARTADO']).optional() });

/**
 * Surtos e sugestões de surto (VIG-1c, §4.3; frente F4). Permissão `vigilancia.surto` (o núcleo só alcança a unidade
 * em que está lotado). `surtos/sugestoes` vem antes de `surtos/:id` (com ParseUUIDPipe, a ordem inversa responde 400).
 */
@Controller('vigilancia')
export class SurtoController {
  constructor(private readonly surtos: SurtoService) {}

  @Get('surtos')
  @RequirePermission('vigilancia.surto')
  listar(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.surtos.listar(ctx, q);
  }

  @Post('surtos')
  @RequirePermission('vigilancia.surto')
  criar(@Ctx() ctx: RequestContext, @Body(zv(novoSchema)) body: z.infer<typeof novoSchema>) {
    return this.surtos.criar(ctx, body);
  }

  @Get('surtos/sugestoes')
  @RequirePermission('vigilancia.surto')
  sugestoes(@Ctx() ctx: RequestContext) {
    return this.surtos.sugestoes(ctx);
  }

  @Post('surtos/sugestoes/dispensar')
  @HttpCode(200)
  @RequirePermission('vigilancia.surto')
  dispensar(@Ctx() ctx: RequestContext, @Body(zv(dispensarSchema)) body: z.infer<typeof dispensarSchema>) {
    return this.surtos.dispensarSugestao(ctx, body);
  }

  @Get('surtos/:id')
  @RequirePermission('vigilancia.surto')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.surtos.detalhe(ctx, id);
  }

  @Patch('surtos/:id')
  @RequirePermission('vigilancia.surto')
  editar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(editarSchema)) body: z.infer<typeof editarSchema>) {
    return this.surtos.editar(ctx, id, body);
  }

  @Post('surtos/:id/casos')
  @RequirePermission('vigilancia.surto')
  incluirCaso(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(casoSchema)) body: z.infer<typeof casoSchema>) {
    return this.surtos.incluirCaso(ctx, id, body);
  }

  @Delete('surtos/:id/casos/:caseId')
  @RequirePermission('vigilancia.surto')
  retirarCaso(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('caseId', ParseUUIDPipe) caseId: string) {
    return this.surtos.retirarCaso(ctx, id, caseId);
  }

  @Post('surtos/:id/comunicacoes')
  @RequirePermission('vigilancia.surto')
  comunicar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(comunicacaoSchema)) body: z.infer<typeof comunicacaoSchema>) {
    return this.surtos.comunicar(ctx, id, body);
  }

  @Post('surtos/:id/encerrar')
  @HttpCode(200)
  @RequirePermission('vigilancia.surto')
  encerrar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(encerrarSchema)) body: z.infer<typeof encerrarSchema>) {
    return this.surtos.encerrar(ctx, id, body);
  }

  @Post('surtos/:id/descartar')
  @HttpCode(200)
  @RequirePermission('vigilancia.surto')
  descartar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(descartarSchema)) body: z.infer<typeof descartarSchema>) {
    return this.surtos.descartar(ctx, id, body);
  }

  @Post('surtos/:id/numero-oficial')
  @HttpCode(200)
  @RequirePermission('vigilancia.surto')
  informarNumero(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(numeroSchema)) body: z.infer<typeof numeroSchema>) {
    return this.surtos.informarNumero(ctx, id, body);
  }

  @Get('surtos/:id/espelho')
  @RequirePermission('vigilancia.surto')
  espelho(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.surtos.espelho(ctx, id);
  }
}
