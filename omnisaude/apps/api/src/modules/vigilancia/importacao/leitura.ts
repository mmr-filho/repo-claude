import {
  SISTEMA_DO_ARQUIVO,
  TIPO_REGISTRO_DO_ARQUIVO,
  type AmostraDuplicado,
  type AmostraRecusa,
  type ArquivoDetectado,
  type CodificacaoArquivo,
  type CodigoPagina,
  type RegistroOficialNormalizado,
  type SistemaOficial,
  type TipoArquivoOficial,
  type TipoRegistroOficial,
} from '@omnisaude/shared';
import { lerCsvOficial, normalizarCabecalho } from './csv-oficial';
import { ErroArquivo, lerDbf, pareceDbf, type LinhaArquivo } from './dbf';
import { detectarTipo, extrairArquivos } from './detectar';
import { preenchidos } from './mescla';
import { normalizarRegistro, type ContextoNormalizacao } from './normalizar';

/**
 * Leitura de um envio inteiro (VIG-1c, frente F2): abre o zip, lê cada DBF ou CSV de forma preguiçosa, detecta o tipo
 * pelo conteúdo, normaliza e junta por chave. Dentro do mesmo arquivo, a chave repetida fica com a linha de mais campos
 * preenchidos (empate: a primeira), com aviso; entre arquivos (NINDINET + DBF do agravo), as partes se somam num
 * registro só e são mescladas campo a campo na aplicação. Função pura: não toca no banco.
 */

export interface OpcoesLeitura extends Omit<ContextoNormalizacao, 'tipo' | 'arquivo'> {
  codificacao?: CodificacaoArquivo;
}

/** Registro do envio: as partes na ordem de aplicação (a notificação antes da investigação). */
export interface RegistroDoEnvio {
  sistema: SistemaOficial;
  tipo: TipoRegistroOficial;
  chave: string;
  partes: RegistroOficialNormalizado[];
}

export interface LeituraEnvio {
  arquivos: ArquivoDetectado[];
  registros: RegistroDoEnvio[];
  lidos: number;
  recusados: number;
  motivosRecusa: Record<string, number>;
  recusas: AmostraRecusa[];
  duplicadosNoArquivo: number;
  duplicados: AmostraDuplicado[];
  avisos: string[];
}

/** Máximo de linhas de cada lista de amostras da prévia. */
export const MAX_AMOSTRAS = 200;
/** Linhas lidas antes de decidir o tipo do arquivo. */
const AMOSTRA_DETECCAO = 200;

/** Ordem de aplicação das partes: notificação (0) antes da ficha de investigação (1). */
const ORDEM_PARTE: Record<TipoArquivoOficial, number> = {
  NINDINET: 0,
  NNEGANET: 0,
  NSURTNET: 0,
  ESUS_NOTIFICA_CSV: 0,
  ESUS_SINAN_CSV: 0,
  AGRAVO_NET: 1,
  DENGON: 1,
  CHIKON: 1,
  TABELA_SINAN: 2,
  DESCONHECIDO: 2,
};

export const chaveDoEnvio = (sistema: SistemaOficial, tipo: TipoRegistroOficial, chave: string) => `${sistema}|${tipo}|${chave}`;

function* encadear<T>(primeiro: T[], resto: Iterator<T>): IterableIterator<T> {
  yield* primeiro;
  for (let r = resto.next(); !r.done; r = resto.next()) yield r.value;
}

/** Linha lida com a posição no arquivo (CSV: linha física, o cabeçalho é a 1; DBF: ordem do registro, a partir de 1). */
interface LinhaNumerada {
  l: LinhaArquivo;
  n: number;
}

interface LeitorArquivo {
  formato: 'DBF' | 'CSV';
  colunas: string[];
  codificacao: CodificacaoArquivo;
  origemCodificacao: ArquivoDetectado['origemCodificacao'];
  avisos: string[];
  linhas: Iterator<LinhaNumerada>;
}

function abrir(bytes: Uint8Array, codificacao: CodificacaoArquivo | undefined): LeitorArquivo | null {
  if (pareceDbf(bytes)) {
    const dbf = lerDbf(bytes, { codificacao: codificacao && codificacao !== 'UTF8' ? (codificacao as CodigoPagina) : undefined });
    const nomes = dbf.campos.map((c) => [c.nome, normalizarCabecalho(c.nome)] as const);
    const linhas = (function* (): IterableIterator<LinhaNumerada> {
      let n = 0;
      for (const bruta of dbf.linhas()) {
        const l: LinhaArquivo = {};
        for (const [orig, norm] of nomes) if (!(norm in l)) l[norm] = bruta[orig] ?? null;
        yield { l, n: ++n };
      }
    })();
    return { formato: 'DBF', colunas: nomes.map(([, norm]) => norm), codificacao: dbf.codificacao, origemCodificacao: dbf.origemCodificacao, avisos: dbf.avisos, linhas };
  }
  // Texto: o CSV não tem byte nulo nas primeiras linhas.
  if (bytes.subarray(0, 4096).includes(0)) return null;
  const csv = lerCsvOficial(bytes, { codificacao: codificacao === 'UTF8' || codificacao === 'CP1252' ? codificacao : undefined });
  const linhas = (function* (): IterableIterator<LinhaNumerada> {
    for (const l of csv.linhas()) yield { l, n: csv.linhaAtual() };
  })();
  return { formato: 'CSV', colunas: csv.colunas, codificacao: csv.codificacao, origemCodificacao: csv.codificacao === 'UTF8' ? 'UTF8' : opcaoCp1252(codificacao), avisos: csv.avisos, linhas };
}
const opcaoCp1252 = (codificacao: CodificacaoArquivo | undefined): ArquivoDetectado['origemCodificacao'] => (codificacao === 'CP1252' ? 'INFORMADA' : 'PONTUACAO');

const ignorado = (nome: string, tamanho: number, tipo: TipoArquivoOficial, aviso: string): ArquivoDetectado => ({
  nome,
  tipo,
  sistema: null,
  tipoRegistro: null,
  tamanhoBytes: tamanho,
  registros: 0,
  codificacao: null,
  origemCodificacao: null,
  agravos: [],
  periodo: null,
  identificado: false,
  ignorado: true,
  avisos: [aviso],
});

/** Lê o envio. Lança `ErroArquivo` com `recusaEnvio` quando o envio inteiro deve ser recusado. */
export function lerEnvio(nome: string, bytes: Uint8Array, opcoes: OpcoesLeitura): LeituraEnvio {
  const arquivos: ArquivoDetectado[] = [];
  const avisos: string[] = [];
  const porChave = new Map<string, RegistroDoEnvio>();
  const motivosRecusa: Record<string, number> = {};
  const recusas: AmostraRecusa[] = [];
  const duplicados: AmostraDuplicado[] = [];
  let lidos = 0;
  let recusados = 0;
  let duplicadosNoArquivo = 0;

  for (const bruto of extrairArquivos(nome, bytes)) {
    if (bruto.ignorado) {
      arquivos.push(ignorado(bruto.nome, 0, 'DESCONHECIDO', `Fora da importação: ${bruto.ignorado}`));
      avisos.push(`${bruto.nome}: fora da importação (${bruto.ignorado}).`);
      continue;
    }
    if (/\.dbc$/i.test(bruto.nome)) {
      arquivos.push(ignorado(bruto.nome, bruto.bytes.length, 'DESCONHECIDO', 'DBC do DATASUS (compactado) não é lido: use a exportação DBF do Sinan'));
      avisos.push(`${bruto.nome}: DBC do DATASUS não é lido; use a exportação DBF do Sinan.`);
      continue;
    }
    let leitor: LeitorArquivo | null;
    try {
      leitor = abrir(bruto.bytes, opcoes.codificacao);
    } catch (e) {
      if (!(e instanceof ErroArquivo) || e.recusaEnvio) throw e;
      arquivos.push(ignorado(bruto.nome, bruto.bytes.length, 'DESCONHECIDO', e.message));
      avisos.push(`${bruto.nome}: ${e.message}.`);
      continue;
    }
    if (!leitor) {
      arquivos.push(ignorado(bruto.nome, bruto.bytes.length, 'DESCONHECIDO', 'Formato não reconhecido (nem DBF nem CSV)'));
      avisos.push(`${bruto.nome}: formato não reconhecido (nem DBF nem CSV).`);
      continue;
    }
    const amostra: LinhaNumerada[] = [];
    for (let r = leitor.linhas.next(); !r.done; r = leitor.linhas.next()) {
      amostra.push(r.value);
      if (amostra.length >= AMOSTRA_DETECCAO) break;
    }
    const tipo = detectarTipo(
      leitor.colunas,
      amostra.map((a) => a.l),
      leitor.formato,
    );
    const sistema = SISTEMA_DO_ARQUIVO[tipo];
    const tipoRegistro = TIPO_REGISTRO_DO_ARQUIVO[tipo];
    if (!sistema || !tipoRegistro) {
      const aviso =
        tipo === 'TABELA_SINAN'
          ? 'Tabela auxiliar do Sinan (municípios, regionais, unidades...): ignorada'
          : `Arquivo não reconhecido como exportação do Sinan ou do e-SUS (colunas: ${leitor.colunas.slice(0, 8).join(', ')}${leitor.colunas.length > 8 ? '...' : ''})`;
      arquivos.push(ignorado(bruto.nome, bruto.bytes.length, tipo, aviso));
      avisos.push(`${bruto.nome}: ${aviso}.`);
      continue;
    }

    const ctx: ContextoNormalizacao = { ...opcoes, tipo, arquivo: bruto.nome };
    const doArquivo = new Map<string, { registro: RegistroOficialNormalizado; linha: number; preenchidos: number; linhas: number[] }>();
    const avisosLinha = new Map<string, number>();
    const agravos = new Set<string>();
    let de: string | null = null;
    let ate: string | null = null;
    let identificado = false;
    let registrosArquivo = 0;
    for (const { l, n: linha } of encadear(amostra, leitor.linhas)) {
      registrosArquivo++;
      lidos++;
      const r = normalizarRegistro(l, ctx);
      if ('recusado' in r) {
        recusados++;
        motivosRecusa[r.recusado] = (motivosRecusa[r.recusado] ?? 0) + 1;
        if (recusas.length < MAX_AMOSTRAS) recusas.push({ arquivo: bruto.nome, linha, numero: l.nu_notific ?? l['numero da notificacao'] ?? null, motivo: r.recusado });
        continue;
      }
      for (const a of r.avisos) avisosLinha.set(a, (avisosLinha.get(a) ?? 0) + 1);
      const reg = r.registro;
      const chave = chaveDoEnvio(reg.sistema, reg.tipo, reg.chave);
      const p = preenchidos(reg);
      const anterior = doArquivo.get(chave);
      if (anterior) {
        duplicadosNoArquivo++;
        anterior.linhas.push(linha);
        if (p > anterior.preenchidos) Object.assign(anterior, { registro: reg, linha, preenchidos: p });
      } else {
        doArquivo.set(chave, { registro: reg, linha, preenchidos: p, linhas: [linha] });
      }
    }
    for (const [chave, d] of doArquivo) {
      const reg = d.registro;
      if (d.linhas.length > 1 && duplicados.length < MAX_AMOSTRAS) duplicados.push({ chave: reg.chave, arquivo: bruto.nome, linhas: d.linhas, mantida: d.linha });
      if (reg.agravo) agravos.add(reg.agravo);
      if (!de || reg.notificadoEm < de) de = reg.notificadoEm;
      if (!ate || reg.notificadoEm > ate) ate = reg.notificadoEm;
      const id = reg.identificacao;
      if (id && (id.nome || id.cns || id.cpf)) identificado = true;
      const atual = porChave.get(chave);
      if (atual) atual.partes.push(reg);
      else porChave.set(chave, { sistema: reg.sistema, tipo: reg.tipo, chave: reg.chave, partes: [reg] });
    }
    const repetidas = [...doArquivo.values()].filter((d) => d.linhas.length > 1).length;
    arquivos.push({
      nome: bruto.nome,
      tipo,
      sistema,
      tipoRegistro,
      tamanhoBytes: bruto.bytes.length,
      registros: registrosArquivo,
      codificacao: leitor.codificacao,
      origemCodificacao: leitor.origemCodificacao,
      agravos: [...agravos].sort(),
      periodo: de && ate ? { de, ate } : null,
      identificado,
      ignorado: false,
      avisos: [
        ...leitor.avisos,
        ...(repetidas ? [`${repetidas} chave(s) repetida(s) no arquivo: ficou a linha com mais campos preenchidos.`] : []),
        ...[...avisosLinha].map(([a, n]) => `${a} (${n} registro${n > 1 ? 's' : ''}).`),
      ],
    });
  }
  const registros = [...porChave.values()];
  for (const r of registros) if (r.partes.length > 1) r.partes.sort((a, b) => ORDEM_PARTE[a.tipoArquivo] - ORDEM_PARTE[b.tipoArquivo]);
  return { arquivos, registros, lidos, recusados, motivosRecusa, recusas, duplicadosNoArquivo, duplicados, avisos };
}

// ───────────── cobertura ─────────────

/** O que o envio cobre: os registros do banco dentro disso que não vieram ficam "ausentes" (nunca apagados). */
export interface Cobertura {
  sistema: SistemaOficial;
  tipo: TipoRegistroOficial;
  /** Agravos presentes (null = registro sem agravo, como a negativa e o e-SUS Notifica). */
  agravos: (string | null)[];
  de: string;
  ate: string;
  /** Municípios de notificação (6 dígitos): o do tenant e os que vieram no arquivo. */
  municipios: string[];
  /** Algum registro veio sem município de notificação. */
  municipioNulo: boolean;
}

/** Cobertura por sistema e tipo: período declarado (ou o das notificações lidas), agravos e municípios presentes. */
export function coberturaDoEnvio(registros: RegistroDoEnvio[], declarado: { de: string; ate: string } | null, municipioTenant: string): Cobertura[] {
  const grupos = new Map<string, Cobertura>();
  for (const r of registros) {
    const ultima = r.partes[r.partes.length - 1]!;
    const k = `${r.sistema}|${r.tipo}`;
    let c = grupos.get(k);
    if (!c) {
      c = { sistema: r.sistema, tipo: r.tipo, agravos: [], de: ultima.notificadoEm, ate: ultima.notificadoEm, municipios: [municipioTenant.slice(0, 6)], municipioNulo: false };
      grupos.set(k, c);
    }
    const agravo = r.partes.find((p) => p.agravo)?.agravo ?? null;
    if (!c.agravos.includes(agravo)) c.agravos.push(agravo);
    if (ultima.notificadoEm < c.de) c.de = ultima.notificadoEm;
    if (ultima.notificadoEm > c.ate) c.ate = ultima.notificadoEm;
    const municipio = r.partes.find((p) => p.municipioNotificacao)?.municipioNotificacao?.slice(0, 6) ?? null;
    if (!municipio) c.municipioNulo = true;
    else if (!c.municipios.includes(municipio)) c.municipios.push(municipio);
  }
  return [...grupos.values()].map((c) => (declarado ? { ...c, de: declarado.de, ate: declarado.ate } : c));
}
