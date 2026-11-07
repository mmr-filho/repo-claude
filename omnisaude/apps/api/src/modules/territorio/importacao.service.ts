import { HttpStatus, Injectable } from '@nestjs/common';
import {
  areaM2,
  areasSobrepoem,
  CATEGORIAS_LOCALIDADE,
  centroDe,
  GeometriaInvalida,
  normalizarArea,
  normalizarCodigoLocalidade,
  normalizarNome,
  normalizarNumeroQuarteirao,
  numeroQuarteiraoValido,
  pontoNaArea,
  ZONAS,
  type Area,
  type CategoriaLocalidade,
  type Zona,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { StorageService } from '../../core/storage.service';
import { ArquivoInvalido, lerCnefe, lerMalha, type EnderecoCnefe } from './leitor-malha';
import { LocalizadorService } from './localizador.service';
import { derivados, TerritorioService, TRAVA_QUARTEIROES } from './territorio.service';

export type TipoImportacao = 'LOCALIDADES' | 'BAIRROS' | 'QUARTEIROES' | 'ENDERECOS';

interface FeicaoValida {
  i: number;
  p: Record<string, unknown>;
  /** Polígono normalizado, ou ponto (só localidades: o centro). */
  g: Area | null;
  ponto: [number, number] | null;
}

export interface Mapeamento {
  numero?: string;
  nome?: string;
  codigo?: string;
  localidade?: string;
  bairro?: string;
  categoria?: string;
  zona?: string;
}

const MAX_ARQUIVO = 10 * 1024 * 1024;
/** Mais que a transação mais longa (5 min) e a religação dos imóveis: depois disso, APLICANDO é processo que caiu. */
const APLICACAO_MAX_MS = 20 * 60_000;

/** Sugestão de qual coluna é o quê, pelos nomes mais comuns nas bases municipais e do IBGE. */
function sugerir(chaves: string[]): Mapeamento {
  const achar = (...res: RegExp[]) => res.map((re) => chaves.find((k) => re.test(k))).find(Boolean);
  return {
    numero: achar(/^(n(u|r)?m?_?)?(quarteir(a|ã)o|quadra|qd)$/i, /^(cd|nu|nr|num)_?(quad|quart)/i, /quart|quad/i, /^(numero|num|nr|n)$/i),
    nome: achar(/^(nome|name|nm_bairro|nm_localid\w*|nm_\w+|bairro|localidade)$/i, /nome|name/i),
    codigo: achar(/^(codigo|cod|cd_localid\w*|cod_localid\w*|cd_loc\w*)$/i, /^c(o)?d/i),
    localidade: achar(/localid/i),
    bairro: achar(/bairro|setor/i),
    categoria: achar(/categ/i),
    zona: achar(/^zona$|situac/i),
  };
}

const texto = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

@Injectable()
export class ImportacaoTerritorioService {
  constructor(
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly localizador: LocalizadorService,
    private readonly territorio: TerritorioService,
  ) {}

  historico(ctx: RequestContext) {
    return ctx.db.territoryImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, kind: true, fileName: true, crs: true, status: true, summary: true, result: true, createdAt: true, appliedAt: true },
    });
  }

  /** Lê o arquivo, valida e guarda o resultado para a aplicação (sem mexer no território ainda). */
  async previa(ctx: RequestContext, input: { tipo: TipoImportacao; nomeArquivo: string; arquivoBase64: string; src?: string | null }) {
    const dados = Buffer.from(input.arquivoBase64, 'base64');
    if (!dados.length) throw new DomainError('ARQUIVO_VAZIO', 'Arquivo vazio', HttpStatus.BAD_REQUEST);
    if (dados.length > MAX_ARQUIVO) throw new DomainError('ARQUIVO_GRANDE', 'Arquivo acima de 10 MB: recorte a camada do município antes de enviar', HttpStatus.PAYLOAD_TOO_LARGE);
    let resumo: Record<string, unknown>;
    let conteudo: unknown;
    let crs: string | null = null;
    try {
      if (input.tipo === 'ENDERECOS') {
        const r = lerCnefe(input.nomeArquivo, dados);
        if (!r.enderecos.length) throw new ArquivoInvalido('Nenhum endereço com coordenada no arquivo');
        const niveis: Record<string, number> = {};
        for (const e of r.enderecos) niveis[e.level] = (niveis[e.level] ?? 0) + 1;
        const ibgeUnidades = new Set((await ctx.db.unit.findMany({ select: { ibgeCode: true } })).map((u) => u.ibgeCode.slice(0, 7)));
        const fora = r.municipios.filter((m) => !ibgeUnidades.has(m.slice(0, 7)));
        resumo = {
          total: r.enderecos.length,
          ignorados: r.ignorados,
          municipios: r.municipios,
          niveis,
          avisos: fora.length ? [`O arquivo é de município(s) sem unidade cadastrada: ${fora.join(', ')}`] : [],
          fonte: 'IBGE, Censo Demográfico 2022 (CNEFE)',
        };
        conteudo = r.enderecos;
      } else {
        const malha = await lerMalha(input.nomeArquivo, dados, input.src);
        crs = malha.src;
        const validas: FeicaoValida[] = [];
        const invalidas: { indice: number; motivo: string }[] = [];
        const tipos: Record<string, number> = {};
        const lascas: string[] = [];
        const nos: string[] = [];
        malha.feicoes.forEach((f, i) => {
          const tipo = f.geometria?.type ?? 'sem geometria';
          tipos[tipo] = (tipos[tipo] ?? 0) + 1;
          if (input.tipo === 'LOCALIDADES' && f.geometria?.type === 'Point') {
            const [lng, lat] = f.geometria.coordinates as unknown[];
            // Só número: coordenada nula ou vazia não vira 0°, 0°.
            if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -75 || lng > -28 || lat < -35 || lat > 6) {
              invalidas.push({ indice: i + 1, motivo: 'Ponto sem coordenada válida no Brasil' });
              return;
            }
            validas.push({ i, p: f.propriedades, g: null, ponto: [lng, lat] });
            return;
          }
          try {
            const avisosFeicao: string[] = [];
            validas.push({ i, p: f.propriedades, g: normalizarArea(f.geometria, avisosFeicao), ponto: null });
            if (avisosFeicao.some((a) => /descartado/.test(a))) lascas.push(String(i + 1));
            if (avisosFeicao.some((a) => /corrigido/.test(a))) nos.push(String(i + 1));
          } catch (err) {
            if (err instanceof GeometriaInvalida) invalidas.push({ indice: i + 1, motivo: err.message });
            else throw err;
          }
        });
        if (!validas.length) throw new ArquivoInvalido(invalidas.length ? `Nenhuma feição válida (${invalidas[0]!.motivo})` : 'O arquivo não tem feições');
        const chaves = [...new Set(validas.flatMap((v) => Object.keys(v.p)))];
        resumo = {
          formato: malha.formato,
          src: malha.src,
          total: malha.feicoes.length,
          validas: validas.length,
          invalidas: invalidas.slice(0, 30),
          totalInvalidas: invalidas.length,
          tipos,
          propriedades: chaves.map((k) => ({
            nome: k,
            exemplos: [
              ...new Set(
                validas
                  .slice(0, 50)
                  .map((v) => texto(v.p[k]))
                  .filter(Boolean),
              ),
            ].slice(0, 3),
          })),
          sugestao: sugerir(chaves),
          avisos: [
            ...malha.avisos,
            ...(lascas.length ? [`${lascas.length} feição(ões) com partes ou furos minúsculos (lascas de recorte), descartados`] : []),
            ...(nos.length ? [`${nos.length} feição(ões) com nó de poucos centímetros no contorno, corrigido`] : []),
          ],
        };
        conteudo = validas;
      }
    } catch (err) {
      if (err instanceof ArquivoInvalido) throw new DomainError('ARQUIVO_INVALIDO', err.message, HttpStatus.BAD_REQUEST);
      throw err;
    }
    const registro = await ctx.db.territoryImport.create({ data: { kind: input.tipo, fileName: input.nomeArquivo.slice(0, 200), crs, summary: resumo as object, createdBy: ctx.session.userId } });
    const storageKey = `territorio/${ctx.tenant.slug}/importacoes/${registro.id}.json`;
    await this.storage.put(storageKey, Buffer.from(JSON.stringify(conteudo)), 'application/json');
    await ctx.db.territoryImport.update({ where: { id: registro.id }, data: { storageKey } });
    return { id: registro.id, tipo: input.tipo, ...resumo };
  }

  /** Aplica a prévia: cria ou atualiza pelo código (localidade), nome (bairro) ou número (quarteirão). */
  async aplicar(ctx: RequestContext, id: string, input: { mapeamento?: Mapeamento; localidadeFixa?: string | null; bairroFixo?: string | null; oficial?: boolean; desativarAusentes?: boolean }) {
    const imp = await ctx.db.territoryImport.findUnique({ where: { id } });
    if (!imp) throw notFound('Importação');
    // APLICANDO há mais tempo que a transação mais longa: o processo caiu no meio (o banco desfez); pode aplicar de novo.
    const travadaAte = new Date(Date.now() - APLICACAO_MAX_MS);
    const presa = imp.status === 'APLICANDO' && !!imp.appliedAt && imp.appliedAt < travadaAte;
    if ((imp.status !== 'PREVIA' && !presa) || !imp.storageKey) {
      if (imp.status === 'APLICANDO') throw new DomainError('JA_APLICADA', 'Esta importação já está sendo aplicada', HttpStatus.CONFLICT);
      throw new DomainError('JA_APLICADA', 'Esta importação já foi aplicada ou descartada: envie o arquivo de novo', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (Date.now() - imp.createdAt.getTime() > 24 * 3_600_000) throw new DomainError('PREVIA_VENCIDA', 'A prévia tem mais de 24 horas: envie o arquivo de novo', HttpStatus.UNPROCESSABLE_ENTITY);
    // appliedAt marca o início da aplicação (e, ao fim, o momento em que ela terminou).
    const { count } = await ctx.db.territoryImport.updateMany({
      where: { id, OR: [{ status: 'PREVIA' }, { status: 'APLICANDO', appliedAt: { lt: travadaAte } }] },
      data: { status: 'APLICANDO', appliedAt: new Date() },
    });
    if (count !== 1) throw new DomainError('JA_APLICADA', 'Esta importação já está sendo aplicada', HttpStatus.CONFLICT);
    try {
      const conteudo = JSON.parse((await this.storage.get(imp.storageKey)).toString('utf8'));
      const m = input.mapeamento ?? {};
      let resultado: Record<string, unknown>;
      if (imp.kind === 'ENDERECOS') resultado = await this.aplicarEnderecos(ctx, conteudo as EnderecoCnefe[]);
      else if (imp.kind === 'LOCALIDADES') resultado = await this.aplicarLocalidades(ctx, conteudo as FeicaoValida[], m);
      else if (imp.kind === 'BAIRROS') resultado = await this.aplicarBairros(ctx, conteudo as FeicaoValida[], m, input);
      else resultado = await this.aplicarQuarteiroes(ctx, conteudo as FeicaoValida[], m, input, Number((imp.summary as { totalInvalidas?: number } | null)?.totalInvalidas ?? 0));
      await ctx.db.territoryImport.update({ where: { id }, data: { status: 'APLICADA', result: resultado as object, appliedBy: ctx.session.userId, appliedAt: new Date() } });
      await this.audit.recordStandalone(ctx, { action: 'territorio.importar', entityType: 'TerritoryImport', entityId: id, payload: { tipo: imp.kind, arquivo: imp.fileName, resultado } });
      return resultado;
    } catch (err) {
      await ctx.db.territoryImport.update({ where: { id }, data: { status: 'PREVIA', appliedAt: null } });
      throw err;
    }
  }

  private async aplicarEnderecos(ctx: RequestContext, enderecos: EnderecoCnefe[]) {
    const municipios = [...new Set(enderecos.map((e) => e.ibgeCode))];
    await ctx.db.$transaction(
      async (tx) => {
        // A base do município é trocada inteira (versão nova do IBGE substitui a anterior).
        await tx.addressPoint.deleteMany({ where: { source: 'CNEFE2022', ibgeCode: { in: municipios } } });
        for (let i = 0; i < enderecos.length; i += 2000) await tx.addressPoint.createMany({ data: enderecos.slice(i, i + 2000).map((e) => ({ ...e, source: 'CNEFE2022' })), skipDuplicates: true });
      },
      { timeout: 120_000 },
    );
    return { enderecos: enderecos.length, municipios };
  }

  private async aplicarLocalidades(ctx: RequestContext, feicoes: FeicaoValida[], m: Mapeamento) {
    if (!m.codigo || !m.nome) throw new DomainError('MAPEAMENTO', 'Indique as colunas do código e do nome da localidade', HttpStatus.BAD_REQUEST);
    const erros: { indice: number; motivo: string }[] = [];
    let criadas = 0;
    let atualizadas = 0;
    await ctx.db.$transaction(
      async (tx) => {
        const vistos = new Set<string>();
        for (const f of feicoes) {
          const code = normalizarCodigoLocalidade(texto(f.p[m.codigo!]));
          const name = texto(f.p[m.nome!]);
          if (!/^\d{1,8}$/.test(code) || !name) {
            erros.push({ indice: f.i + 1, motivo: 'Código (até 8 dígitos) ou nome ausente' });
            continue;
          }
          if (vistos.has(code)) {
            erros.push({ indice: f.i + 1, motivo: `Código ${code} repetido no arquivo` });
            continue;
          }
          vistos.add(code);
          const cat = texto(m.categoria ? f.p[m.categoria] : '').toUpperCase();
          const zon = texto(m.zona ? f.p[m.zona] : '').toUpperCase();
          const geo = f.g ? derivados(f.g) : f.ponto ? { centerLng: f.ponto[0], centerLat: f.ponto[1] } : {};
          const data = {
            name,
            ...((CATEGORIAS_LOCALIDADE as readonly string[]).includes(cat) ? { category: cat as CategoriaLocalidade } : {}),
            ...((ZONAS as readonly string[]).includes(zon) ? { zone: zon as Zona } : {}),
            ...geo,
            source: 'IMPORTACAO',
          };
          const atual = await tx.locality.findFirst({ where: { code, status: 'ATIVA' }, select: { id: true } });
          if (atual) {
            await tx.locality.update({ where: { id: atual.id }, data });
            atualizadas++;
          } else {
            await tx.locality.create({ data: { code, ...data, createdBy: ctx.session.userId } });
            criadas++;
          }
        }
      },
      { timeout: 120_000 },
    );
    return { criadas, atualizadas, erros: erros.slice(0, 50), totalErros: erros.length };
  }

  /** Localidade da feição: fixa na tela ou pela coluna (código ou nome). */
  private async resolverLocalidade(tx: RequestContext['db'], fixa: string | null | undefined, valor: string, cache: Map<string, string | null>) {
    if (fixa) return fixa;
    if (!valor) return null;
    if (cache.has(valor)) return cache.get(valor)!;
    // Código numérico com ou sem zeros à esquerda (o DBF numérico perde os zeros).
    const digitos = /^\d+$/.test(valor) ? normalizarCodigoLocalidade(valor) : '';
    const l =
      (digitos ? await tx.locality.findFirst({ where: { code: digitos, status: 'ATIVA' }, select: { id: true } }) : null) ??
      (await tx.locality.findMany({ where: { status: 'ATIVA' }, select: { id: true, name: true } })).find((x) => normalizarNome(x.name) === normalizarNome(valor)) ??
      null;
    cache.set(valor, l?.id ?? null);
    return l?.id ?? null;
  }

  private async aplicarBairros(ctx: RequestContext, feicoes: FeicaoValida[], m: Mapeamento, input: { localidadeFixa?: string | null; oficial?: boolean }) {
    if (!m.nome) throw new DomainError('MAPEAMENTO', 'Indique a coluna do nome do bairro', HttpStatus.BAD_REQUEST);
    if (!input.localidadeFixa && !m.localidade) throw new DomainError('MAPEAMENTO', 'Escolha a localidade dos bairros ou a coluna que a indica', HttpStatus.BAD_REQUEST);
    if (input.localidadeFixa && !(await ctx.db.locality.findFirst({ where: { id: input.localidadeFixa, status: 'ATIVA' } }))) throw notFound('Localidade');
    const erros: { indice: number; motivo: string }[] = [];
    let criados = 0;
    let atualizados = 0;
    await ctx.db.$transaction(
      async (tx) => {
        const cache = new Map<string, string | null>();
        const vistos = new Set<string>();
        for (const f of feicoes) {
          const name = texto(f.p[m.nome!]);
          const localityId = await this.resolverLocalidade(tx as RequestContext['db'], input.localidadeFixa, texto(m.localidade ? f.p[m.localidade] : ''), cache);
          if (!name || !localityId || !f.g) {
            erros.push({ indice: f.i + 1, motivo: !name ? 'Nome ausente' : !localityId ? 'Localidade não encontrada' : 'Sem polígono' });
            continue;
          }
          const chave = `${localityId}|${normalizarNome(name)}`;
          if (vistos.has(chave)) {
            erros.push({ indice: f.i + 1, motivo: `Bairro ${name} repetido no arquivo (junte as partes num só polígono)` });
            continue;
          }
          vistos.add(chave);
          // O bairro já cadastrado com esse nome ou apelido é o mesmo bairro (fica o nome dele); dois candidatos é erro.
          const candidatos = (await tx.neighborhood.findMany({ where: { localityId, active: true }, select: { id: true, name: true, aliases: true } })).filter((b) =>
            [b.name, ...b.aliases].some((n) => normalizarNome(n) === normalizarNome(name)),
          );
          if (candidatos.length > 1) {
            erros.push({ indice: f.i + 1, motivo: `O nome ${name} casa com mais de um bairro (${candidatos.map((c) => c.name).join(', ')})` });
            continue;
          }
          const atual = candidatos[0];
          if (atual && vistos.has(atual.id)) {
            erros.push({ indice: f.i + 1, motivo: `Bairro ${atual.name} repetido no arquivo (outro nome ou apelido dele já veio)` });
            continue;
          }
          if (atual) vistos.add(atual.id);
          const data = { ...derivados(f.g), source: 'IMPORTACAO', ...(input.oficial !== undefined ? { official: input.oficial } : {}), ...(m.codigo ? { code: texto(f.p[m.codigo]).slice(0, 20) || null } : {}) };
          if (atual) {
            await tx.neighborhood.update({ where: { id: atual.id }, data });
            atualizados++;
          } else {
            await tx.neighborhood.create({ data: { localityId, name, ...data } });
            criados++;
          }
        }
      },
      { timeout: 120_000 },
    );
    return { criados, atualizados, erros: erros.slice(0, 50), totalErros: erros.length };
  }

  private async aplicarQuarteiroes(
    ctx: RequestContext,
    feicoes: FeicaoValida[],
    m: Mapeamento,
    input: { localidadeFixa?: string | null; bairroFixo?: string | null; desativarAusentes?: boolean },
    invalidasNaPrevia: number,
  ) {
    if (!m.numero) throw new DomainError('MAPEAMENTO', 'Indique a coluna do número do quarteirão', HttpStatus.BAD_REQUEST);
    if (!input.localidadeFixa && !m.localidade) throw new DomainError('MAPEAMENTO', 'Escolha a localidade dos quarteirões ou a coluna que a indica', HttpStatus.BAD_REQUEST);
    const porBairro = ctx.tenant.settings.territorio.numeracaoQuarteirao === 'BAIRRO';
    const erros: { indice: number; motivo: string }[] = [];
    const sobreposicoes: string[] = [];
    const avisos: string[] = [];
    let criados = 0;
    let atualizados = 0;
    let desativados = 0;
    await ctx.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRAVA_QUARTEIROES}))`;
        // Depois da trava: a localidade (e o bairro) escolhidos na tela podem ter sido extintos nesse meio-tempo.
        if (input.localidadeFixa && !(await tx.locality.findFirst({ where: { id: input.localidadeFixa, status: 'ATIVA' }, select: { id: true } }))) throw notFound('Localidade ativa');
        if (input.bairroFixo && !(await tx.neighborhood.findFirst({ where: { id: input.bairroFixo, active: true, ...(input.localidadeFixa ? { localityId: input.localidadeFixa } : {}) }, select: { id: true } })))
          throw notFound('Bairro ativo da localidade');
        const cache = new Map<string, string | null>();
        const bairros = await tx.neighborhood.findMany({ where: { active: true }, select: { id: true, localityId: true, name: true, aliases: true, geometry: true } });
        const tocadas = new Set<string>();
        const gravados = new Set<string>();
        const novos: { chave: string; g: Area; numero: string }[] = [];
        for (const f of feicoes) {
          if (!f.g) {
            erros.push({ indice: f.i + 1, motivo: 'Sem polígono' });
            continue;
          }
          const numero = normalizarNumeroQuarteirao(texto(f.p[m.numero!]));
          const localityId = await this.resolverLocalidade(tx as RequestContext['db'], input.localidadeFixa, texto(m.localidade ? f.p[m.localidade] : ''), cache);
          if (!numeroQuarteiraoValido(numero) || !localityId) {
            erros.push({ indice: f.i + 1, motivo: !localityId ? 'Localidade não encontrada' : `Número inválido: "${numero}"` });
            continue;
          }
          // Bairro: fixo, pela coluna (nome ou apelido) ou pelo polígono que contém o centro do quarteirão.
          const doLocal = bairros.filter((b) => b.localityId === localityId);
          const nomeBairro = normalizarNome(texto(m.bairro ? f.p[m.bairro] : ''));
          const centro = centroDe(f.g);
          const bairro = input.bairroFixo
            ? (doLocal.find((b) => b.id === input.bairroFixo) ?? null)
            : nomeBairro
              ? (doLocal.find((b) => normalizarNome(b.name) === nomeBairro || b.aliases.some((a) => normalizarNome(a) === nomeBairro)) ?? null)
              : (doLocal.find((b) => b.geometry && pontoNaArea(centro, b.geometry as unknown as Area)) ?? null);
          if (porBairro && !bairro) {
            erros.push({ indice: f.i + 1, motivo: 'Numeração por bairro: bairro não encontrado' });
            continue;
          }
          const neighborhoodId = bairro?.id ?? null;
          const chave = `${localityId}|${porBairro ? neighborhoodId : ''}|${numero}`;
          if (gravados.has(chave)) {
            erros.push({ indice: f.i + 1, motivo: `Quarteirão ${numero} repetido no arquivo` });
            continue;
          }
          gravados.add(chave);
          tocadas.add(localityId);
          const data = { localityId, neighborhoodId, number: numero, ...derivados(f.g), areaM2: Math.round(areaM2(f.g) * 10) / 10, source: 'IMPORTACAO', updatedBy: ctx.session.userId };
          const atual = await tx.block.findFirst({ where: { active: true, localityId, number: numero, ...(porBairro ? { neighborhoodId } : {}) }, select: { id: true, neighborhoodId: true } });
          if (atual) {
            // Arquivo sem bairro para este quarteirão: fica o bairro que ele já tinha (editor ou importação anterior).
            await tx.block.update({ where: { id: atual.id }, data: { ...data, neighborhoodId: neighborhoodId ?? atual.neighborhoodId } });
            atualizados++;
          } else {
            await tx.block.create({ data: { ...data, createdBy: ctx.session.userId } });
            criados++;
          }
          novos.push({ chave, g: f.g, numero });
        }
        // Sobreposição entre os quarteirões do arquivo: aviso (malhas digitalizadas têm imperfeições), não bloqueio.
        for (let i = 0; i < novos.length && sobreposicoes.length < 30; i++)
          for (let j = i + 1; j < novos.length && sobreposicoes.length < 30; j++) if (areasSobrepoem(novos[i]!.g, novos[j]!.g)) sobreposicoes.push(`${novos[i]!.numero} × ${novos[j]!.numero}`);
        if (input.desativarAusentes && (erros.length || invalidasNaPrevia)) {
          // Feição com erro não diz se o quarteirão saiu da malha: nada é desativado.
          avisos.push(`Nenhum quarteirão foi desativado: ${erros.length + invalidasNaPrevia} feição(ões) do arquivo tiveram erro. Corrija e aplique de novo.`);
        } else if (input.desativarAusentes && tocadas.size) {
          const ausentes = await tx.block.findMany({ where: { active: true, localityId: { in: [...tocadas] } }, select: { id: true, localityId: true, neighborhoodId: true, number: true } });
          const sair = ausentes.filter((b) => !gravados.has(`${b.localityId}|${porBairro ? b.neighborhoodId : ''}|${b.number}`)).map((b) => b.id);
          if (sair.length) {
            await tx.$executeRaw`UPDATE households SET block_id = NULL WHERE block_id = ANY(${sair}::uuid[])`;
            desativados = (await tx.block.updateMany({ where: { id: { in: sair } }, data: { active: false, updatedBy: ctx.session.userId } })).count;
          }
        }
      },
      { timeout: 300_000 },
    );
    const mudaram: string[] = [];
    const vinculo = await this.localizador.vincularTodos(ctx.db, (ids) => mudaram.push(...ids));
    // Imóveis que mudaram de quarteirão com a malha nova: a ordem de bloqueio dos moradores é reavaliada.
    await this.territorio.imoveisPosicionados(ctx, mudaram);
    return { criados, atualizados, desativados, erros: erros.slice(0, 50), totalErros: erros.length, sobreposicoes, avisos, imoveis: vinculo };
  }
}
