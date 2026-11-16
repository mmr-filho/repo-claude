import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { LeitorCsv, normalizarCabecalho, ValidadorUtf8 } from './csv-oficial';
import { bytesDoCabecalho, ErroArquivo, lerCabecalhoDbf, LeitorDbf, type LinhaArquivo } from './dbf';
import { detectarTipo } from './detectar';
import { abrirEnvio, ContadorBytes, pedacos, type EntradaEnvio } from './entrada';
import { LIMITE_REGISTROS, mensagemTetoRegistros } from './limites';
import { preenchidos } from './mescla';
import { COLUNAS_LIDAS, normalizarRegistro, type ContextoNormalizacao } from './normalizar';
import { codificarParte, decodificarParte, TabelaColunas } from './payload';
import { plana, Ritmo } from './ritmo';

/**
 * Leitura de um envio inteiro (VIG-1c, frente F2), em fluxo: abre o zip pelo diretório central, lê cada DBF ou CSV em
 * pedaços, detecta o tipo pelo conteúdo, normaliza e grava cada parte num arquivo temporário. Na memória fica só o
 * índice das chaves. Dentro do mesmo arquivo, a chave repetida fica com a linha de mais campos preenchidos (empate: a
 * primeira), com aviso; entre arquivos (NINDINET + DBF do agravo), as partes se somam num registro só e são mescladas
 * campo a campo na aplicação. Não toca no banco. `fechar` apaga o arquivo temporário.
 */

export interface OpcoesLeitura extends Omit<ContextoNormalizacao, 'tipo' | 'arquivo'> {
  codificacao?: CodificacaoArquivo;
  ritmo?: Ritmo;
  /** Teto de linhas lidas (padrão: `LIMITE_REGISTROS`). */
  limiteRegistros?: number;
}

/** Registro do envio: as partes na ordem de aplicação (a notificação antes da investigação). */
export interface RegistroDoEnvio {
  sistema: SistemaOficial;
  tipo: TipoRegistroOficial;
  chave: string;
  partes: RegistroOficialNormalizado[];
}

/** Máximo de linhas de cada lista de amostras da prévia. */
export const MAX_AMOSTRAS = 200;
/** Linhas lidas antes de decidir o tipo do arquivo. */
const AMOSTRA_DETECCAO = 200;
/** Linhas guardadas por chave repetida na amostra. */
const MAX_LINHAS_REPETIDA = 50;
/** Avisos de linha diferentes por arquivo (o resto soma em "outros avisos"). */
const MAX_AVISOS_LINHA = 50;
/** Pedaço máximo entregue de uma vez ao leitor do DBF ou do CSV. */
const PASSO_LEITOR = 512 * 1024;

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
  PLANILHA_SURTO: 2,
  DESCONHECIDO: 2,
};

const COD_SISTEMA: Record<SistemaOficial, string> = { SINAN_NET: 'N', SINAN_ONLINE: 'O', ESUS_SINAN: 'S', ESUS_NOTIFICA: 'E', SIVEP_GRIPE: 'G', SINASC_SIM: 'M' };
const COD_TIPO: Record<TipoRegistroOficial, string> = { INDIVIDUAL: 'I', NEGATIVA: 'N', SURTO: 'S' };

/** Chave do registro no envio (sistema, tipo e chave natural), curta: fica no índice durante o envio inteiro. */
export const chaveDoEnvio = (sistema: string, tipo: string, chave: string) => `${COD_SISTEMA[sistema as SistemaOficial] ?? sistema}${COD_TIPO[tipo as TipoRegistroOficial] ?? tipo}|${chave}`;

// ───────────── arquivo temporário das partes ─────────────

const BUFFER_SPOOL = 1024 * 1024;
const LEITURA_SPOOL = 4 * 1024 * 1024;
/** Buraco (partes trocadas por uma linha repetida melhor) que ainda vale ler junto. */
const BURACO_SPOOL = 16 * 1024;

class Spool {
  private readonly dir = mkdtempSync(join(tmpdir(), 'omni-importacao-'));
  private readonly fd = openSync(join(this.dir, 'partes'), 'w+');
  private gravados = 0;
  private readonly buf = Buffer.allocUnsafe(BUFFER_SPOOL);
  private usados = 0;
  private fechado = false;

  gravar(texto: string): [number, number] {
    const len = Buffer.byteLength(texto, 'utf8');
    const pos = this.gravados + this.usados;
    if (this.usados + len > this.buf.length) this.descarregar();
    if (len > this.buf.length) {
      writeSync(this.fd, Buffer.from(texto, 'utf8'), 0, len, this.gravados);
      this.gravados += len;
    } else {
      this.buf.write(texto, this.usados, len, 'utf8');
      this.usados += len;
    }
    return [pos, len];
  }

  descarregar() {
    if (!this.usados) return;
    writeSync(this.fd, this.buf, 0, this.usados, this.gravados);
    this.gravados += this.usados;
    this.usados = 0;
  }

  ler(pos: number, len: number): Buffer {
    const b = Buffer.allocUnsafe(len);
    for (let lidos = 0; lidos < len; ) {
      const n = readSync(this.fd, b, lidos, len - lidos, pos + lidos);
      if (!n) throw new Error('Arquivo temporário da importação cortado');
      lidos += n;
    }
    return b;
  }

  fechar() {
    if (this.fechado) return;
    this.fechado = true;
    try {
      closeSync(this.fd);
    } finally {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }
}

// ───────────── índice das chaves ─────────────

const crescerI32 = (a: Int32Array, n: number) => {
  const b = new Int32Array(n);
  b.set(a);
  return b;
};

/** Chave → registro; registro → lista encadeada das partes (posição no arquivo temporário). Só números, fora o mapa. */
class Indice {
  readonly mapa = new Map<string, number>();
  registros = 0;
  partes = 0;
  primeira = new Int32Array(1024);
  ultima = new Int32Array(1024);
  pos = new Float64Array(1024);
  len = new Int32Array(1024);
  arq = new Int32Array(1024);
  pre = new Int32Array(1024);
  linha = new Int32Array(1024);
  prox = new Int32Array(1024);
  repetida = new Uint8Array(1024);

  novaParte(pos: number, len: number, arq: number, pre: number, linha: number): number {
    if (this.partes === this.pos.length) {
      const n = this.pos.length * 2;
      const pos2 = new Float64Array(n);
      pos2.set(this.pos);
      this.pos = pos2;
      this.len = crescerI32(this.len, n);
      this.arq = crescerI32(this.arq, n);
      this.pre = crescerI32(this.pre, n);
      this.linha = crescerI32(this.linha, n);
      this.prox = crescerI32(this.prox, n);
      const rep = new Uint8Array(n);
      rep.set(this.repetida);
      this.repetida = rep;
    }
    const p = this.partes++;
    this.pos[p] = pos;
    this.len[p] = len;
    this.arq[p] = arq;
    this.pre[p] = pre;
    this.linha[p] = linha;
    this.prox[p] = -1;
    return p;
  }

  novoRegistro(chave: string, parte: number) {
    if (this.registros === this.primeira.length) {
      this.primeira = crescerI32(this.primeira, this.primeira.length * 2);
      this.ultima = crescerI32(this.ultima, this.ultima.length * 2);
    }
    const r = this.registros++;
    this.primeira[r] = parte;
    this.ultima[r] = parte;
    this.mapa.set(chave, r);
  }

  encadear(registro: number, parte: number) {
    this.prox[this.ultima[registro]!] = parte;
    this.ultima[registro] = parte;
  }
}

// ───────────── cobertura ─────────────

/** O que o envio cobre: os registros do banco dentro disso que não vieram ficam "ausentes" (nunca apagados). */
export interface Cobertura {
  sistema: SistemaOficial;
  tipo: TipoRegistroOficial;
  /** Agravos presentes (null = registro sem agravo, como a negativa e o e-SUS Notifica). */
  agravos: (string | null)[];
  /** e-SUS Notifica: fichas (grupos) presentes; a ausência só vale dentro da mesma ficha. */
  grupos?: string[];
  /** e-SUS com um CNES só no arquivo (exportação do autocadastro, filtro por estabelecimento): a ausência fica nele. */
  cnes?: string[];
  de: string;
  ate: string;
  /** Municípios de notificação (6 dígitos): o do tenant e os que vieram no arquivo. */
  municipios: string[];
  /** Algum registro veio sem município de notificação. */
  municipioNulo: boolean;
}

interface CoberturaAberta extends Omit<Cobertura, 'grupos' | 'cnes'> {
  grupos: Set<string>;
  cnes: Set<string>;
  cnesNulo: boolean;
}

const ROTULO_SISTEMA_CURTO: Record<SistemaOficial, string> = {
  SINAN_NET: 'Sinan Net',
  SINAN_ONLINE: 'Sinan Online',
  ESUS_SINAN: 'e-SUS Sinan',
  ESUS_NOTIFICA: 'e-SUS Notifica',
  SIVEP_GRIPE: 'Sivep-Gripe',
  SINASC_SIM: 'Sinasc/SIM',
};

/** Cobertura por sistema e tipo, somada registro a registro: período declarado (ou o das notificações), agravos, municípios. */
export class AcumuladorCobertura {
  private readonly grupos = new Map<string, CoberturaAberta>();
  private semFicha = 0;

  constructor(
    private readonly declarado: { de: string; ate: string } | null,
    private readonly municipioTenant: string,
  ) {}

  somar(r: RegistroDoEnvio) {
    // Só cobre o sistema o registro que veio de um arquivo dele: a dengue de um NINDINET antigo não cobre o Sinan Online.
    if (!r.partes.some((p) => SISTEMA_DO_ARQUIVO[p.tipoArquivo] === r.sistema)) return;
    const grupo = r.partes.find((p) => p.grupo)?.grupo ?? null;
    // e-SUS Notifica sem a ficha identificada (CSV sem as colunas da síndrome gripal): não marca ausência em ficha nenhuma.
    if (r.sistema === 'ESUS_NOTIFICA' && !grupo) {
      this.semFicha++;
      return;
    }
    const ultima = r.partes[r.partes.length - 1]!;
    const k = `${r.sistema}|${r.tipo}`;
    let c = this.grupos.get(k);
    if (!c) {
      c = {
        sistema: r.sistema,
        tipo: r.tipo,
        agravos: [],
        grupos: new Set(),
        cnes: new Set(),
        cnesNulo: false,
        de: ultima.notificadoEm,
        ate: ultima.notificadoEm,
        municipios: [this.municipioTenant.slice(0, 6)],
        municipioNulo: false,
      };
      this.grupos.set(k, c);
    }
    const agravo = r.partes.find((p) => p.agravo)?.agravo ?? null;
    if (!c.agravos.includes(agravo)) c.agravos.push(plana(agravo));
    if (grupo && !c.grupos.has(grupo)) c.grupos.add(plana(grupo));
    if (ultima.notificadoEm < c.de) c.de = ultima.notificadoEm;
    if (ultima.notificadoEm > c.ate) c.ate = ultima.notificadoEm;
    const municipio = r.partes.find((p) => p.municipioNotificacao)?.municipioNotificacao?.slice(0, 6) ?? null;
    if (!municipio) c.municipioNulo = true;
    else if (!c.municipios.includes(municipio)) c.municipios.push(municipio);
    const cnes = r.partes.find((p) => p.cnes)?.cnes ?? null;
    if (!cnes) c.cnesNulo = true;
    else if (c.cnes.size < 2) c.cnes.add(cnes);
  }

  resultado(): { cobertura: Cobertura[]; avisos: string[] } {
    const avisos: string[] = [];
    const cobertura = [...this.grupos.values()].map(({ grupos, cnes, cnesNulo, ...c }): Cobertura => {
      const out: Cobertura = { ...c };
      if (this.declarado) Object.assign(out, this.declarado);
      if (c.sistema === 'ESUS_NOTIFICA') out.grupos = [...grupos].sort();
      if ((c.sistema === 'ESUS_NOTIFICA' || c.sistema === 'ESUS_SINAN') && cnes.size === 1 && !cnesNulo) {
        out.cnes = [...cnes];
        avisos.push(`${ROTULO_SISTEMA_CURTO[c.sistema]}: o arquivo traz um CNES só (${out.cnes[0]}). Os ausentes ficam restritos a esse estabelecimento.`);
      }
      return out;
    });
    if (this.semFicha)
      avisos.push(
        cobertura.some((c) => c.sistema === 'ESUS_NOTIFICA')
          ? `e-SUS Notifica: ${this.semFicha} registro(s) sem a ficha identificada ficaram fora da marcação de ausentes.`
          : 'e-SUS Notifica sem as colunas da síndrome gripal: nenhum registro foi marcado como ausente.',
      );
    return { cobertura, avisos };
  }
}

/** Cobertura de uma lista de registros (o mesmo que somar um a um). */
export function coberturaDoEnvio(registros: RegistroDoEnvio[], declarado: { de: string; ate: string } | null, municipioTenant: string): Cobertura[] {
  const a = new AcumuladorCobertura(declarado, municipioTenant);
  for (const r of registros) a.somar(r);
  return a.resultado().cobertura;
}

// ───────────── leitura ─────────────

interface LinhaNumerada {
  l: LinhaArquivo;
  /** CSV: linha física (o cabeçalho é a 1); DBF: ordem do registro, a partir de 1. */
  n: number;
}

interface Leitor {
  formato: 'DBF' | 'CSV';
  colunas(): string[];
  avisos(): string[];
  codificacao(): CodificacaoArquivo;
  origemCodificacao(): ArquivoDetectado['origemCodificacao'];
  push(p: Uint8Array): LinhaNumerada[];
  fim(): LinhaNumerada[];
}

interface EstadoArquivo {
  idx: number;
  nome: string;
  registros: number;
  agravos: Set<string>;
  grupos: Set<string>;
  de: string | null;
  ate: string | null;
  identificado: boolean;
  repetidas: number;
  avisosLinha: Map<string, number>;
}

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

/** Arquivo do envio como fica gravado (official_imports.files): o `ArquivoDetectado` e os grupos do catálogo presentes. */
export type ArquivoLido = ArquivoDetectado & { grupos?: string[] };

/** Envio lido: amostras e contagens na memória; os registros, no arquivo temporário (`registros` os entrega em lotes). */
export class LeituraEnvio {
  readonly arquivos: ArquivoLido[] = [];
  readonly avisos: string[] = [];
  lidos = 0;
  recusados = 0;
  readonly motivosRecusa: Record<string, number> = {};
  readonly recusas: AmostraRecusa[] = [];
  duplicadosNoArquivo = 0;
  readonly duplicados: AmostraDuplicado[] = [];
  private readonly indice = new Indice();
  private readonly spool = new Spool();
  private readonly tabela = new TabelaColunas();
  private readonly amostraRepetidas = new Map<string, AmostraDuplicado>();
  private arquivosLidos = 0;

  constructor(
    private readonly limite: number,
    private readonly ritmo: Ritmo = new Ritmo(),
  ) {}

  /** Registros (chaves) do envio. */
  get total(): number {
    return this.indice.registros;
  }

  /** A chave (`chaveDoEnvio`) veio no envio. */
  tem(chave: string): boolean {
    return this.indice.mapa.has(chave);
  }

  /** Apaga o arquivo temporário (sempre, no fim da prévia). */
  fechar() {
    this.spool.fechar();
  }

  /** Os registros na ordem em que apareceram, em lotes, com as partes lidas do arquivo temporário. */
  async *registros(tamanho = 500): AsyncGenerator<RegistroDoEnvio[]> {
    this.spool.descarregar();
    const ix = this.indice;
    for (let ini = 0; ini < ix.registros; ini += tamanho) {
      const fim = Math.min(ix.registros, ini + tamanho);
      const refs: number[] = [];
      for (let r = ini; r < fim; r++) for (let p = ix.primeira[r]!; p >= 0; p = ix.prox[p]!) refs.push(p);
      const partes = this.lerPartes(refs);
      const lote: RegistroDoEnvio[] = [];
      for (let r = ini; r < fim; r++) {
        const doRegistro: RegistroOficialNormalizado[] = [];
        for (let p = ix.primeira[r]!; p >= 0; p = ix.prox[p]!) doRegistro.push(decodificarParte(partes.get(p)!, this.tabela));
        if (doRegistro.length > 1) doRegistro.sort((a, b) => ORDEM_PARTE[a.tipoArquivo] - ORDEM_PARTE[b.tipoArquivo]);
        const p0 = doRegistro[0]!;
        lote.push({ sistema: p0.sistema, tipo: p0.tipo, chave: p0.chave, partes: doRegistro });
      }
      yield lote;
      // Quem consome pode não esperar nada de fora entre um lote e outro: o laço de eventos respira aqui.
      await this.ritmo.ceder();
    }
  }

  /** Partes lidas do arquivo temporário: em ordem de posição, juntando as vizinhas numa leitura só. */
  private lerPartes(refs: number[]): Map<number, unknown[]> {
    const ix = this.indice;
    const ordem = refs.sort((a, b) => ix.pos[a]! - ix.pos[b]!);
    const out = new Map<number, unknown[]>();
    for (let i = 0; i < ordem.length; ) {
      const ini = ix.pos[ordem[i]!]!;
      let fim = ini + ix.len[ordem[i]!]!;
      let j = i;
      while (j + 1 < ordem.length) {
        const prox = ordem[j + 1]!;
        const pos = ix.pos[prox]!;
        if (pos - fim > BURACO_SPOOL || pos + ix.len[prox]! - ini > LEITURA_SPOOL) break;
        fim = Math.max(fim, pos + ix.len[prox]!);
        j++;
      }
      const buf = this.spool.ler(ini, fim - ini);
      for (let k = i; k <= j; k++) {
        const p = ordem[k]!;
        const s = ix.pos[p]! - ini;
        out.set(p, JSON.parse(buf.toString('utf8', s, s + ix.len[p]!)) as unknown[]);
      }
      i = j + 1;
    }
    return out;
  }

  // ── fase de leitura ──

  async lerEntrada(e: EntradaEnvio, opcoes: OpcoesLeitura, ritmo: Ritmo, contador: ContadorBytes) {
    if (e.ignorado) {
      this.arquivos.push(ignorado(e.nome, 0, 'DESCONHECIDO', `Fora da importação: ${e.ignorado}`));
      this.avisos.push(`${e.nome}: fora da importação (${e.ignorado}).`);
      return;
    }
    if (/\.dbc$/i.test(e.nome)) {
      this.arquivos.push(ignorado(e.nome, e.tamanho, 'DESCONHECIDO', 'DBC do DATASUS (compactado) não é lido: use a exportação DBF do Sinan'));
      this.avisos.push(`${e.nome}: DBC do DATASUS não é lido; use a exportação DBF do Sinan.`);
      return;
    }
    // Estado do arquivo: preenchido quando o tipo é detectado (depois das primeiras linhas).
    const st: { estado: EstadoArquivo | null; ctx: ContextoNormalizacao | null; tipo: TipoArquivoOficial | null; fora: boolean } = { estado: null, ctx: null, tipo: null, fora: false };
    try {
      const leitor = await this.abrir(e, opcoes, ritmo);
      if (!leitor) {
        this.arquivos.push(ignorado(e.nome, e.tamanho, 'DESCONHECIDO', 'Formato não reconhecido (nem DBF nem CSV)'));
        this.avisos.push(`${e.nome}: formato não reconhecido (nem DBF nem CSV).`);
        return;
      }
      const amostra: LinhaNumerada[] = [];
      const detectar = () => {
        const tipo = detectarTipo(
          leitor.colunas(),
          amostra.map((a) => a.l),
          leitor.formato,
        );
        st.tipo = tipo;
        if (!SISTEMA_DO_ARQUIVO[tipo] || !TIPO_REGISTRO_DO_ARQUIVO[tipo]) {
          st.fora = true;
          return;
        }
        st.ctx = { ...opcoes, tipo, arquivo: e.nome };
        st.estado = this.novoArquivo(e.nome);
        for (const a of amostra.splice(0)) this.linha(a.l, a.n, st.estado, st.ctx);
      };
      const consumir = async (linhas: LinhaNumerada[]) => {
        for (let i = 0; i < linhas.length && !st.fora; i++) {
          const x = linhas[i]!;
          if (st.ctx && st.estado) {
            this.linha(x.l, x.n, st.estado, st.ctx);
            if ((i & 255) === 255) await ritmo.ceder();
          } else {
            amostra.push(x);
            if (amostra.length >= AMOSTRA_DETECCAO) detectar();
          }
        }
      };
      for await (const p of pedacos(e, ritmo, contador)) {
        for (let o = 0; o < p.length && !st.fora; o += PASSO_LEITOR) await consumir(leitor.push(p.subarray(o, o + PASSO_LEITOR)));
        if (st.fora) break;
      }
      if (!st.fora) await consumir(leitor.fim());
      if (!st.fora && !st.ctx) detectar();
      if (st.fora || !st.estado || !st.tipo) {
        const tipoFora = st.tipo ?? 'DESCONHECIDO';
        const colunas = leitor.colunas();
        const aviso =
          tipoFora === 'TABELA_SINAN'
            ? 'Tabela auxiliar do Sinan (municípios, regionais, unidades...): ignorada'
            : tipoFora === 'PLANILHA_SURTO'
              ? 'Planilha de acompanhamento do surto (uma linha por caso): ignorada. O surto vem do NSURTNET'
              : `Arquivo não reconhecido como exportação do Sinan ou do e-SUS (colunas: ${colunas.slice(0, 8).join(', ')}${colunas.length > 8 ? '...' : ''})`;
        this.arquivos.push(ignorado(e.nome, e.tamanho, tipoFora, aviso));
        this.avisos.push(`${e.nome}: ${aviso}.`);
        return;
      }
      this.fecharArquivo(st.estado, st.tipo, leitor, e);
    } catch (x) {
      if (!(x instanceof ErroArquivo) || x.recusaEnvio) throw x;
      // Erro do arquivo depois de linhas já lidas não tem volta: recusa o envio.
      if (st.estado) throw new ErroArquivo(`${e.nome}: ${x.message}`, true);
      this.arquivos.push(ignorado(e.nome, e.tamanho, 'DESCONHECIDO', x.message));
      this.avisos.push(`${e.nome}: ${x.message}.`);
    }
  }

  /** O leitor certo para a entrada (DBF pelo cabeçalho coerente; CSV se não houver byte nulo no começo). */
  private async abrir(e: EntradaEnvio, opcoes: OpcoesLeitura, ritmo: Ritmo): Promise<Leitor | null> {
    const inicio = await primeirosBytes(e, ritmo);
    const cabecalho = lerCabecalhoDbf(inicio);
    if (cabecalho) {
      const cod = opcoes.codificacao && opcoes.codificacao !== 'UTF8' ? (opcoes.codificacao as CodigoPagina) : undefined;
      const dbf = new LeitorDbf({ codificacao: cod, chave: normalizarCabecalho, lidas: COLUNAS_LIDAS });
      let n = 0;
      const numerar = (linhas: LinhaArquivo[]) => linhas.map((l) => ({ l, n: ++n }));
      return {
        formato: 'DBF',
        colunas: () => dbf.colunas,
        avisos: () => dbf.avisos,
        codificacao: () => dbf.codificacao!,
        origemCodificacao: () => dbf.origemCodificacao,
        push: (p) => numerar(dbf.push(p)),
        fim: () => numerar(dbf.fim()),
      };
    }
    if (inicio.subarray(0, 4096).includes(0)) return null;
    // Texto: confere o UTF-8 do arquivo inteiro antes de ler (um caractere inválido no fim muda a leitura toda).
    const avisos: string[] = [];
    let codificacao: 'UTF8' | 'CP1252';
    let origem: ArquivoDetectado['origemCodificacao'];
    if (opcoes.codificacao === 'CP1252') {
      codificacao = 'CP1252';
      origem = 'INFORMADA';
    } else {
      const v = new ValidadorUtf8();
      for await (const p of pedacos(e, ritmo)) v.push(p);
      if (v.fim()) {
        codificacao = 'UTF8';
        origem = 'UTF8';
      } else {
        if (opcoes.codificacao === 'UTF8') throw new ErroArquivo('O arquivo não é UTF-8 válido');
        codificacao = 'CP1252';
        origem = 'PONTUACAO';
        avisos.push('O arquivo não é UTF-8 válido: foi lido como Windows-1252. Confira os acentos na prévia.');
      }
    }
    const csv = new LeitorCsv({ codificacao, lidas: COLUNAS_LIDAS });
    return {
      formato: 'CSV',
      colunas: () => csv.colunas,
      avisos: () => [...avisos, ...csv.avisos],
      codificacao: () => codificacao,
      origemCodificacao: () => origem,
      push: (p) => csv.push(p),
      fim: () => csv.fim(),
    };
  }

  private novoArquivo(nome: string): EstadoArquivo {
    return { idx: this.arquivosLidos++, nome, registros: 0, agravos: new Set(), grupos: new Set(), de: null, ate: null, identificado: false, repetidas: 0, avisosLinha: new Map() };
  }

  private fecharArquivo(a: EstadoArquivo, tipo: TipoArquivoOficial, leitor: Leitor, e: EntradaEnvio) {
    const detectado: ArquivoLido = {
      nome: e.nome,
      tipo,
      sistema: SISTEMA_DO_ARQUIVO[tipo],
      tipoRegistro: TIPO_REGISTRO_DO_ARQUIVO[tipo],
      tamanhoBytes: e.tamanho,
      registros: a.registros,
      codificacao: leitor.codificacao(),
      origemCodificacao: leitor.origemCodificacao(),
      agravos: [...a.agravos].sort(),
      periodo: a.de && a.ate ? { de: a.de, ate: a.ate } : null,
      identificado: a.identificado,
      ignorado: false,
      avisos: [
        ...leitor.avisos(),
        ...(a.repetidas ? [`${a.repetidas} chave(s) repetida(s) no arquivo: ficou a linha com mais campos preenchidos.`] : []),
        ...[...a.avisosLinha].map(([aviso, n]) => `${aviso} (${n} registro${n > 1 ? 's' : ''}).`),
      ],
      grupos: [...a.grupos].sort(),
    };
    this.arquivos.push(detectado);
  }

  private gravarParte(reg: RegistroOficialNormalizado): [number, number] {
    const { i } = this.tabela.indice(reg.colunas);
    return this.spool.gravar(JSON.stringify(codificarParte(reg, i, this.tabela.chavesExtras(i))));
  }

  private linha(l: LinhaArquivo, n: number, a: EstadoArquivo, ctx: ContextoNormalizacao) {
    if (++this.lidos > this.limite) throw new ErroArquivo(mensagemTetoRegistros(), true);
    a.registros++;
    const r = normalizarRegistro(l, ctx);
    if ('recusado' in r) {
      this.recusados++;
      this.motivosRecusa[r.recusado] = (this.motivosRecusa[r.recusado] ?? 0) + 1;
      if (this.recusas.length < MAX_AMOSTRAS) this.recusas.push({ arquivo: a.nome, linha: n, numero: plana(l.nu_notific ?? l['numero da notificacao'] ?? null), motivo: r.recusado });
      return;
    }
    for (const aviso of r.avisos) {
      const n = a.avisosLinha.get(aviso);
      if (n !== undefined) a.avisosLinha.set(aviso, n + 1);
      else if (a.avisosLinha.size < MAX_AVISOS_LINHA) a.avisosLinha.set(plana(aviso), 1);
      else a.avisosLinha.set('Outros avisos', (a.avisosLinha.get('Outros avisos') ?? 0) + 1);
    }
    const reg = r.registro;
    const ix = this.indice;
    const chave = plana(chaveDoEnvio(reg.sistema, reg.tipo, reg.chave));
    const pre = preenchidos(reg);
    const registro = ix.mapa.get(chave);
    if (registro !== undefined && ix.arq[ix.ultima[registro]!] === a.idx) {
      // Repetida no mesmo arquivo: fica a linha com mais campos preenchidos (empate: a primeira).
      const ult = ix.ultima[registro]!;
      this.duplicadosNoArquivo++;
      if (!ix.repetida[ult]) {
        ix.repetida[ult] = 1;
        a.repetidas++;
      }
      const k = `${a.idx}|${chave}`;
      let d = this.amostraRepetidas.get(k);
      if (!d && this.duplicados.length < MAX_AMOSTRAS) {
        d = { chave: plana(reg.chave), arquivo: a.nome, linhas: [ix.linha[ult]!], mantida: ix.linha[ult]! };
        this.duplicados.push(d);
        this.amostraRepetidas.set(k, d);
      }
      if (d && d.linhas.length < MAX_LINHAS_REPETIDA) d.linhas.push(n);
      if (pre > ix.pre[ult]!) {
        const [pos, len] = this.gravarParte(reg);
        ix.pos[ult] = pos;
        ix.len[ult] = len;
        ix.pre[ult] = pre;
        ix.linha[ult] = n;
        if (d) d.mantida = n;
      }
    } else {
      const [pos, len] = this.gravarParte(reg);
      const parte = ix.novaParte(pos, len, a.idx, pre, n);
      if (registro !== undefined) ix.encadear(registro, parte);
      else ix.novoRegistro(chave, parte);
    }
    if (reg.agravo && !a.agravos.has(reg.agravo)) a.agravos.add(plana(reg.agravo));
    if (reg.grupo && !a.grupos.has(reg.grupo)) a.grupos.add(plana(reg.grupo));
    if (!a.de || reg.notificadoEm < a.de) a.de = reg.notificadoEm;
    if (!a.ate || reg.notificadoEm > a.ate) a.ate = reg.notificadoEm;
    const id = reg.identificacao;
    if (id && (id.nome || id.cns || id.cpf)) a.identificado = true;
  }
}

/** Os primeiros bytes da entrada: o cabeçalho do DBF inteiro ou 4 KB (o resto é lido de novo, do começo). */
async function primeirosBytes(e: EntradaEnvio, ritmo: Ritmo): Promise<Uint8Array> {
  const partes: Uint8Array[] = [];
  let n = 0;
  for await (const p of pedacos(e, ritmo)) {
    partes.push(p);
    n += p.length;
    const juntos = partes.length === 1 ? p : Buffer.concat(partes);
    if (partes.length > 1) partes.splice(0, partes.length, juntos);
    if (n >= Math.max(4096, bytesDoCabecalho(juntos))) break;
  }
  return partes.length === 1 ? partes[0]! : Buffer.concat(partes);
}

/** Lê o envio (sem tocar no banco). Lança `ErroArquivo` com `recusaEnvio` quando o envio inteiro deve ser recusado. */
export async function lerEnvio(nome: string, bytes: Uint8Array, opcoes: OpcoesLeitura): Promise<LeituraEnvio> {
  const ritmo = opcoes.ritmo ?? new Ritmo();
  const leitura = new LeituraEnvio(opcoes.limiteRegistros ?? LIMITE_REGISTROS, ritmo);
  try {
    const contador = new ContadorBytes();
    for (const e of abrirEnvio(nome, bytes)) await leitura.lerEntrada(e, opcoes, ritmo, contador);
    return leitura;
  } catch (e) {
    leitura.fechar();
    throw e;
  }
}
