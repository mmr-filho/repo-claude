import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CATEGORIAS_LOCALIDADE, ZONAS } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { GeocodificacaoService } from './geocodificacao.service';
import { ImportacaoTerritorioService } from './importacao.service';
import { SRC_CONHECIDOS } from './leitor-malha';
import { TerritorioService } from './territorio.service';

const num = z.coerce.number();
const caixaSchema = z.object({ bbox: z.string().regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/) });
const raioSchema = z.object({ lat: num.min(-90).max(90), lng: num.min(-180).max(180), metros: z.coerce.number().int().min(10).max(2000).optional() });
const imoveisSchema = z.object({ situacao: z.enum(['SEM_POSICAO', 'SEM_QUARTEIRAO', 'BAIXA_PRECISAO']), take: z.coerce.number().int().min(1).max(1000).optional() });
const geometria = z.object({ type: z.enum(['Polygon', 'MultiPolygon']), coordinates: z.array(z.any()) });
const localidadeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{1,8}$/),
  name: z.string().trim().min(2).max(120),
  category: z.enum(CATEGORIAS_LOCALIDADE).optional(),
  zone: z.enum(ZONAS).optional(),
  geometry: geometria.nullish(),
  notes: z.string().max(500).nullish(),
});
const localidadeEdicaoSchema = localidadeSchema.partial().extend({ status: z.enum(['ATIVA', 'EXTINTA']).optional() });
const bairroSchema = z.object({
  localityId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().max(20).nullish(),
  official: z.boolean().optional(),
  aliases: z.array(z.string().trim().max(120)).max(20).optional(),
  geometry: geometria.nullish(),
});
const bairroEdicaoSchema = bairroSchema.omit({ localityId: true }).partial().extend({ active: z.boolean().optional() });
const quarteiraoSchema = z.object({
  localityId: z.string().uuid(),
  neighborhoodId: z.string().uuid().nullish(),
  number: z.string().trim().min(1).max(10),
  geometry: geometria,
  notes: z.string().max(500).nullish(),
});
const quarteiraoEdicaoSchema = quarteiraoSchema.partial().extend({ versao: z.string().datetime().optional() });
const motivoSchema = z.object({ reason: z.string().trim().min(5).max(500) });
const posicaoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  origem: z.enum(['MAPA', 'GPS']),
  accuracyM: z.number().min(0).max(10000).nullish(),
  confianca: z.union([z.literal(68), z.literal(95)]).optional(),
  sequencia: z.string().trim().max(12).nullish(),
});
const geocodificarSchema = z.object({ ids: z.array(z.string().uuid()).max(5000).optional(), limite: z.number().int().min(1).max(50_000).optional(), apos: z.string().uuid().optional() });
const previaSchema = z.object({
  tipo: z.enum(['LOCALIDADES', 'BAIRROS', 'QUARTEIROES', 'ENDERECOS']),
  nomeArquivo: z.string().trim().min(3).max(200),
  arquivoBase64: z.string().min(10),
  src: z.enum(Object.keys(SRC_CONHECIDOS) as [string, ...string[]]).nullish(),
});
const coluna = z.string().max(80).optional();
const aplicarSchema = z.object({
  mapeamento: z.object({ numero: coluna, nome: coluna, codigo: coluna, localidade: coluna, bairro: coluna, categoria: coluna, zona: coluna }).optional(),
  localidadeFixa: z.string().uuid().nullish(),
  bairroFixo: z.string().uuid().nullish(),
  oficial: z.boolean().optional(),
  desativarAusentes: z.boolean().optional(),
});
const configSchema = z.object({ numeracaoQuarteirao: z.enum(['LOCALIDADE', 'BAIRRO']).optional(), raioBloqueioM: z.number().int().min(50).max(1000).optional() });

/** Território (PLT-3): localidades, bairros, quarteirões, imóveis, importação de malha e geocodificação local. */
@Controller('territorio')
export class TerritorioController {
  constructor(
    private readonly territorio: TerritorioService,
    private readonly importacao: ImportacaoTerritorioService,
    private readonly geocodificacao: GeocodificacaoService,
  ) {}

  @Get('resumo')
  @RequirePermission('territorio.ler')
  resumo(@Ctx() ctx: RequestContext) {
    return this.territorio.resumo(ctx);
  }

  @Get('mapa')
  @RequirePermission('territorio.ler')
  mapa(@Ctx() ctx: RequestContext, @Query(zv(caixaSchema)) q: z.infer<typeof caixaSchema>) {
    const [x0, y0, x1, y1] = q.bbox.split(',').map(Number) as [number, number, number, number];
    return this.territorio.mapa(ctx, [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
  }

  @Get('raio')
  @RequirePermission('territorio.ler')
  raio(@Ctx() ctx: RequestContext, @Query(zv(raioSchema)) q: z.infer<typeof raioSchema>) {
    return this.territorio.raio(ctx, q.lat, q.lng, q.metros);
  }

  @Get('imoveis')
  @RequirePermission('territorio.ler')
  imoveis(@Ctx() ctx: RequestContext, @Query(zv(imoveisSchema)) q: z.infer<typeof imoveisSchema>) {
    return this.territorio.imoveis(ctx, q);
  }

  @Post('imoveis/:id/posicao')
  @HttpCode(200)
  @RequirePermission('territorio.editar', 'acs.campo', 'endemias.campo')
  posicao(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(posicaoSchema)) body: z.infer<typeof posicaoSchema>) {
    return this.territorio.posicionarImovel(ctx, id, body);
  }

  @Post('imoveis/geocodificar')
  @HttpCode(200)
  @RequirePermission('territorio.editar')
  geocodificar(@Ctx() ctx: RequestContext, @Body(zv(geocodificarSchema)) body: z.infer<typeof geocodificarSchema>) {
    return this.geocodificacao.geocodificar(ctx, body);
  }

  @Post('imoveis/vincular')
  @HttpCode(200)
  @RequirePermission('territorio.editar')
  vincular(@Ctx() ctx: RequestContext) {
    return this.territorio.vincularTodos(ctx);
  }

  @Get('localidades')
  @RequirePermission('territorio.ler')
  localidades(@Ctx() ctx: RequestContext) {
    return this.territorio.localidades(ctx);
  }

  @Post('localidades')
  @RequirePermission('territorio.editar')
  criarLocalidade(@Ctx() ctx: RequestContext, @Body(zv(localidadeSchema)) body: z.infer<typeof localidadeSchema>) {
    return this.territorio.salvarLocalidade(ctx, null, body);
  }

  @Patch('localidades/:id')
  @RequirePermission('territorio.editar')
  editarLocalidade(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(localidadeEdicaoSchema)) body: z.infer<typeof localidadeEdicaoSchema>) {
    return this.territorio.salvarLocalidade(ctx, id, body);
  }

  @Get('bairros')
  @RequirePermission('territorio.ler')
  bairros(@Ctx() ctx: RequestContext, @Query('localidade') localidade?: string) {
    return this.territorio.bairros(ctx, localidade && /^[0-9a-f-]{36}$/i.test(localidade) ? localidade : undefined);
  }

  @Post('bairros')
  @RequirePermission('territorio.editar')
  criarBairro(@Ctx() ctx: RequestContext, @Body(zv(bairroSchema)) body: z.infer<typeof bairroSchema>) {
    return this.territorio.salvarBairro(ctx, null, body);
  }

  @Patch('bairros/:id')
  @RequirePermission('territorio.editar')
  editarBairro(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(bairroEdicaoSchema)) body: z.infer<typeof bairroEdicaoSchema>) {
    return this.territorio.salvarBairro(ctx, id, body);
  }

  @Get('quarteiroes')
  @RequirePermission('territorio.ler')
  quarteiroes(@Ctx() ctx: RequestContext, @Query('localidade') localidade?: string, @Query('bairro') bairro?: string) {
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    return this.territorio.quarteiroes(ctx, { localityId: uuid(localidade), neighborhoodId: uuid(bairro) });
  }

  @Get('quarteiroes/:id')
  @RequirePermission('territorio.ler')
  quarteirao(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.territorio.quarteirao(ctx, id);
  }

  @Post('quarteiroes')
  @RequirePermission('territorio.editar')
  criarQuarteirao(@Ctx() ctx: RequestContext, @Body(zv(quarteiraoSchema)) body: z.infer<typeof quarteiraoSchema>) {
    return this.territorio.salvarQuarteirao(ctx, null, body);
  }

  @Patch('quarteiroes/:id')
  @RequirePermission('territorio.editar')
  editarQuarteirao(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(quarteiraoEdicaoSchema)) body: z.infer<typeof quarteiraoEdicaoSchema>) {
    return this.territorio.salvarQuarteirao(ctx, id, body);
  }

  @Post('quarteiroes/:id/desativar')
  @HttpCode(200)
  @RequirePermission('territorio.editar')
  desativarQuarteirao(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.territorio.desativarQuarteirao(ctx, id, body.reason);
  }

  @Get('importacoes')
  @RequirePermission('territorio.editar')
  importacoes(@Ctx() ctx: RequestContext) {
    return this.importacao.historico(ctx);
  }

  @Post('importacoes/previa')
  @HttpCode(200)
  @RequirePermission('territorio.editar')
  previa(@Ctx() ctx: RequestContext, @Body(zv(previaSchema)) body: z.infer<typeof previaSchema>) {
    return this.importacao.previa(ctx, body);
  }

  @Post('importacoes/:id/aplicar')
  @HttpCode(200)
  @RequirePermission('territorio.editar')
  aplicar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(aplicarSchema)) body: z.infer<typeof aplicarSchema>) {
    return this.importacao.aplicar(ctx, id, body);
  }

  @Get('configuracoes')
  @RequirePermission('territorio.ler')
  configuracoes(@Ctx() ctx: RequestContext) {
    return { ...this.territorio.config(ctx), srcAceitos: Object.entries(SRC_CONHECIDOS).map(([codigo, v]) => ({ codigo, label: v.label })) };
  }

  @Patch('configuracoes')
  @RequirePermission('territorio.editar')
  salvarConfiguracoes(@Ctx() ctx: RequestContext, @Body(zv(configSchema)) body: z.infer<typeof configSchema>) {
    return this.territorio.salvarConfiguracoes(ctx, body);
  }
}
