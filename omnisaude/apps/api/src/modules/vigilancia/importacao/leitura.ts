import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROTULO_TIPO_ARQUIVO,
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
 * primeira), com aviso; entre arquivos de tipos diferentes (NINDINET + DBF do agravo), as partes se somam num registro
 * só e são mescladas campo a campo na aplicação. Uma parte por tipo de arquivo: a chave repetida em outro arquivo do
 * mesmo tipo fica com a do último arquivo, com aviso (sem isso, o mesmo arquivo repetido no zip juntava milhares de
 * partes num registro e derrubava o processo). Não toca no banco. `fechar` apaga o arquivo temporário.
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
  /**
   * Arquivo do envio de onde veio a primeira parte (a ordem de leitura, a partir de 0) e o CNES único dele (o arquivo do
   * e-SUS com todos os registros com CNES, e um só; null nos outros). Só na leitura do envio (`LeituraEnvio.registros`):
   * não vai para o payload. A cobertura usa para restringir os ausentes aos CNES dos arquivos.
   */
  arquivo?: number;
  cnesDoArquivo?: string | null;
}

/** Máximo de linhas de cada lista de amostras da prévia. */
export const MAX_AMOSTRAS = 200;
/** Linhas lidas antes de decidir o tipo do arquivo. */
const AMOSTRA_DETECCAO = 200;
/** Linhas guardadas por chave repetida na amostra. */
const MAX_LINHAS_REPETIDA = 50;
/** Avisos de linha diferentes por arquivo (o resto soma em "outros avisos"). */
const MAX_AVISOS_LINHA = 50;
/** Arquivos ignorados guardados um a um (em `arquivos`, nos avisos e no erro sem registros); o resto vira "mais X". */
export const MAX_IGNORADOS = 50;
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
  /**
   * e-SUS em que cada arquivo do sistema traz um CNES só (a exportação do autocadastro, uma por estabelecimento; ou o
   * zip com as de algumas unidades): a ausência fica nos CNES desses arquivos (a união).
   */
  cnes?: string[];
  /** Período: o declarado ou o das notificações, com o fim na data do primeiro envio do arquivo (`resultado`). */
  de: string;
  ate: string;
  /** Municípios de notificação (6 dígitos): o do tenant e os que vieram no arquivo. */
  municipios: string[];
  /** Algum registro veio sem município de notificação. */
  municipioNulo: boolean;
}

/** CNES de um arquivo na cobertura: os dos registros (até 2: basta saber se há um só) e se algum veio sem CNES. */
interface CnesDoArquivo {
  cnes: Set<string>;
  nulo: boolean;
}

interface CoberturaAberta extends Omit<Cobertura, 'grupos' | 'cnes'> {
  grupos: Set<string>;
  /** e-SUS: o CNES de cada arquivo que entrou na cobertura, pelo índice do arquivo no envio (-1: registro sem o arquivo). */
  cnesPorArquivo: Map<number, CnesDoArquivo>;
}

/**
 * Os CNES que restringem a cobertura de um sistema e tipo do e-SUS: a união dos CNES dos arquivos, quando todo arquivo
 * traz um CNES só e nenhum registro vem sem CNES; null (o município inteiro) nos demais casos. O mesmo critério vale para
 * a cobertura (os ausentes) e para o `cnes` de cada arquivo (official_imports.files, lido pela conciliação e pela base
 * consolidada).
 */
export function cnesRestritos(arquivos: readonly CnesDoArquivo[]): string[] | null {
  if (!arquivos.length || arquivos.some((a) => a.nulo || a.cnes.size !== 1)) return null;
  return [...new Set(arquivos.map((a) => [...a.cnes][0]!))].sort();
}

const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const ROTULO_SISTEMA_CURTO: Record<SistemaOficial, string> = {
  SINAN_NET: 'Sinan Net',
  SINAN_ONLINE: 'Sinan Online',
  ESUS_SINAN: 'e-SUS Sinan',
  ESUS_NOTIFICA: 'e-SUS Notifica',
  SIVEP_GRIPE: 'Sivep-Gripe',
  SINASC_SIM: 'Sinasc/SIM',
};

/**
 * Cobertura por sistema e tipo, somada registro a registro: período declarado (ou o das notificações), agravos,
 * municípios e, no e-SUS, o CNES de cada arquivo (a cobertura fica nos CNES dos arquivos quando cada um traz um só).
 */
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
        cnesPorArquivo: new Map(),
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
    if (SISTEMAS_POR_CNES.includes(r.sistema)) {
      // O CNES do arquivo de onde o registro veio (o da leitura, igual para todos os registros do arquivo). O registro
      // montado sem o arquivo conta pelo próprio CNES, como se o envio fosse um arquivo só.
      const arquivo = r.arquivo ?? -1;
      let a = c.cnesPorArquivo.get(arquivo);
      if (!a) c.cnesPorArquivo.set(arquivo, (a = { cnes: new Set(), nulo: false }));
      const cnes = r.arquivo !== undefined ? (r.cnesDoArquivo ?? null) : (r.partes.find((p) => p.cnes)?.cnes ?? null);
      if (!cnes) a.nulo = true;
      else if (a.cnes.size < 2 && !a.cnes.has(cnes)) a.cnes.add(plana(cnes));
    }
  }

  /**
   * A cobertura de cada sistema e tipo, com os avisos. `limite` (AAAA-MM-DD): a data local do primeiro envio do arquivo
   * (o mesmo SHA-256, em qualquer situação). A exportação não traz o que veio depois dela: o fim da cobertura não passa
   * dessa data, mesmo com o arquivo reenviado depois para declarar o período; a cobertura que começaria depois dela não
   * cobre nada (nenhum ausente).
   */
  resultado(limite?: string | null): { cobertura: Cobertura[]; avisos: string[] } {
    const avisos: string[] = [];
    const cobertura: Cobertura[] = [];
    let depoisDoEnvio = false;
    for (const { grupos, cnesPorArquivo, ...c } of this.grupos.values()) {
      const out: Cobertura = { ...c };
      if (this.declarado) Object.assign(out, this.declarado);
      if (limite && out.ate > limite) out.ate = limite;
      if (out.de > out.ate) {
        depoisDoEnvio = true;
        continue;
      }
      if (c.sistema === 'ESUS_NOTIFICA') out.grupos = [...grupos].sort();
      const cnes = SISTEMAS_POR_CNES.includes(c.sistema) ? cnesRestritos([...cnesPorArquivo.values()]) : null;
      if (cnes) {
        out.cnes = cnes;
        avisos.push(
          cnes.length === 1
            ? `${ROTULO_SISTEMA_CURTO[c.sistema]}: o envio traz um CNES só (${cnes[0]}): os ausentes valem só para esse estabelecimento.`
            : `${ROTULO_SISTEMA_CURTO[c.sistema]}: o envio traz só os estabelecimentos ${cnes.join(', ')}: os ausentes valem só para eles.`,
        );
      }
      cobertura.push(out);
    }
    if (depoisDoEnvio && limite && this.declarado) avisos.push(`O período declarado começa depois do primeiro envio deste arquivo (${dataBr(limite)}): nada do período fica marcado como ausente.`);
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
  tipo: TipoArquivoOficial;
  registros: number;
  agravos: Set<string>;
  grupos: Set<string>;
  /** CNES dos registros que entram na cobertura (até 2: basta saber se há um só). */
  cnes: Set<string>;
  /** Algum registro da cobertura sem CNES. */
  cnesNulo: boolean;
  /** Registros que entram na cobertura (o e-SUS Notifica sem a ficha identificada, não). */
  cobertos: number;
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
  cnes: null,
  periodo: null,
  identificado: false,
  ignorado: true,
  avisos: [aviso],
});

/** Sistemas em que o arquivo de um CNES só restringe os ausentes (e a cobertura) ao estabelecimento. */
const SISTEMAS_POR_CNES: readonly SistemaOficial[] = ['ESUS_NOTIFICA', 'ESUS_SINAN'];

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
  /** Tipo de cada arquivo lido, pelo índice (para achar a parte do mesmo tipo de arquivo na lista do registro). */
  private readonly tiposDosArquivos: TipoArquivoOficial[] = [];
  /** Chaves repetidas em outro arquivo do mesmo tipo, por tipo: quantas e o último arquivo (o que ficou). */
  private readonly repetidasEntreArquivos = new Map<TipoArquivoOficial, { n: number; arquivo: string }>();
  /** Arquivos ignorados (os primeiros `MAX_IGNORADOS` ficam na lista). */
  private ignorados = 0;
  /** CNES único de cada arquivo lido, pelo índice (null: não é do e-SUS, traz mais de um ou registro sem CNES). */
  private readonly cnesDosArquivos: (string | null)[] = [];
  /** Arquivos do e-SUS com registros na cobertura, por sistema e tipo: o `cnes` deles sai em `fecharArquivos`. */
  private readonly arquivosPorCnes = new Map<string, { arquivo: ArquivoLido; cnes: CnesDoArquivo }[]>();

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

  /**
   * Os registros na ordem em que apareceram, em lotes, com as partes lidas do arquivo temporário. O lote fecha em
   * `tamanho` registros ou em `2 × tamanho` partes (o registro que sozinho passa disso vai num lote só dele): o que fica
   * na memória é medido pelas partes.
   */
  async *registros(tamanho = 500): AsyncGenerator<RegistroDoEnvio[]> {
    this.spool.descarregar();
    const ix = this.indice;
    const tetoPartes = tamanho * 2;
    for (let ini = 0; ini < ix.registros; ) {
      const refs: number[] = [];
      let fim = ini;
      while (fim < ix.registros && fim - ini < tamanho) {
        const antes = refs.length;
        for (let p = ix.primeira[fim]!; p >= 0; p = ix.prox[p]!) refs.push(p);
        if (refs.length > tetoPartes && fim > ini) {
          refs.length = antes;
          break;
        }
        fim++;
      }
      const partes = this.lerPartes(refs);
      const lote: RegistroDoEnvio[] = [];
      for (let r = ini; r < fim; r++) {
        const doRegistro: RegistroOficialNormalizado[] = [];
        for (let p = ix.primeira[r]!; p >= 0; p = ix.prox[p]!) doRegistro.push(decodificarParte(partes.get(p)!, this.tabela));
        if (doRegistro.length > 1) doRegistro.sort((a, b) => ORDEM_PARTE[a.tipoArquivo] - ORDEM_PARTE[b.tipoArquivo]);
        const p0 = doRegistro[0]!;
        const arquivo = ix.arq[ix.primeira[r]!]!;
        lote.push({ sistema: p0.sistema, tipo: p0.tipo, chave: p0.chave, partes: doRegistro, arquivo, cnesDoArquivo: this.cnesDosArquivos[arquivo] ?? null });
      }
      ini = fim;
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

  /**
   * Arquivo fora da importação: os primeiros `MAX_IGNORADOS` ficam na lista e nos avisos, um a um; os demais viram uma
   * linha só no fim da leitura (`fecharIgnorados`). Sem o teto, um zip com centenas de entradas estranhas enchia a lista,
   * os avisos e o erro sem registros.
   */
  private ignorar(arquivo: ArquivoLido, aviso: string) {
    if (++this.ignorados > MAX_IGNORADOS) return;
    this.arquivos.push(arquivo);
    this.avisos.push(aviso);
  }

  /**
   * Fecha a leitura dos arquivos: o CNES de cada arquivo do e-SUS (pelo critério da cobertura: o CNES único do arquivo
   * só fica quando todo arquivo do mesmo sistema e tipo traz um CNES só; senão, null em todos), os ignorados além do
   * teto e as chaves repetidas em arquivos do mesmo tipo.
   */
  fecharArquivos() {
    for (const lista of this.arquivosPorCnes.values()) {
      const restritos = cnesRestritos(lista.map((x) => x.cnes));
      for (const x of lista) x.arquivo.cnes = restritos ? [...x.cnes.cnes][0]! : null;
    }
    for (const [tipo, { n, arquivo }] of this.repetidasEntreArquivos)
      this.avisos.push(
        `${n.toLocaleString('pt-BR')} registro(s) repetido(s) em mais de um arquivo do mesmo tipo (${ROTULO_TIPO_ARQUIVO[tipo]}): ficou a versão do último arquivo lido (${arquivo}). Confira se o zip não traz a mesma exportação duas vezes.`,
      );
    const mais = this.ignorados - MAX_IGNORADOS;
    if (mais <= 0) return;
    const texto = `mais ${mais.toLocaleString('pt-BR')} arquivo(s) fora da importação`;
    this.arquivos.push(ignorado(`(${texto})`, 0, 'DESCONHECIDO', `A lista mostra só os ${MAX_IGNORADOS} primeiros arquivos fora da importação.`));
    this.avisos.push(`E ${texto}.`);
  }

  async lerEntrada(e: EntradaEnvio, opcoes: OpcoesLeitura, ritmo: Ritmo, contador: ContadorBytes) {
    if (e.ignorado) {
      this.ignorar(ignorado(e.nome, 0, 'DESCONHECIDO', `Fora da importação: ${e.ignorado}`), `${e.nome}: fora da importação (${e.ignorado}).`);
      return;
    }
    if (/\.dbc$/i.test(e.nome)) {
      this.ignorar(ignorado(e.nome, e.tamanho, 'DESCONHECIDO', 'DBC do DATASUS (compactado) não é lido: use a exportação DBF do Sinan'), `${e.nome}: DBC do DATASUS não é lido; use a exportação DBF do Sinan.`);
      return;
    }
    // Estado do arquivo: preenchido quando o tipo é detectado (depois das primeiras linhas).
    const st: { estado: EstadoArquivo | null; ctx: ContextoNormalizacao | null; tipo: TipoArquivoOficial | null; fora: boolean } = { estado: null, ctx: null, tipo: null, fora: false };
    try {
      const leitor = await this.abrir(e, opcoes, ritmo);
      if (!leitor) {
        this.ignorar(ignorado(e.nome, e.tamanho, 'DESCONHECIDO', 'Formato não reconhecido (nem DBF nem CSV)'), `${e.nome}: formato não reconhecido (nem DBF nem CSV).`);
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
        st.estado = this.novoArquivo(e.nome, tipo);
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
        this.ignorar(ignorado(e.nome, e.tamanho, tipoFora, aviso), `${e.nome}: ${aviso}.`);
        return;
      }
      this.fecharArquivo(st.estado, st.tipo, leitor, e);
    } catch (x) {
      if (!(x instanceof ErroArquivo) || x.recusaEnvio) throw x;
      // Erro do arquivo depois de linhas já lidas não tem volta: recusa o envio.
      if (st.estado) throw new ErroArquivo(`${e.nome}: ${x.message}`, true);
      this.ignorar(ignorado(e.nome, e.tamanho, 'DESCONHECIDO', x.message), `${e.nome}: ${x.message}.`);
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

  private novoArquivo(nome: string, tipo: TipoArquivoOficial): EstadoArquivo {
    const idx = this.arquivosLidos++;
    this.tiposDosArquivos[idx] = tipo;
    return {
      idx,
      nome,
      tipo,
      registros: 0,
      agravos: new Set(),
      grupos: new Set(),
      cnes: new Set(),
      cnesNulo: false,
      cobertos: 0,
      de: null,
      ate: null,
      identificado: false,
      repetidas: 0,
      avisosLinha: new Map(),
    };
  }

  private fecharArquivo(a: EstadoArquivo, tipo: TipoArquivoOficial, leitor: Leitor, e: EntradaEnvio) {
    const sistema = SISTEMA_DO_ARQUIVO[tipo];
    const tipoRegistro = TIPO_REGISTRO_DO_ARQUIVO[tipo];
    // e-SUS: todos os registros da cobertura com CNES, e um só. O `cnes` do arquivo sai em `fecharArquivos`, com os
    // outros arquivos do mesmo sistema e tipo.
    const porCnes = !!sistema && SISTEMAS_POR_CNES.includes(sistema) && a.cobertos > 0;
    const unico = porCnes && a.cnes.size === 1 && !a.cnesNulo ? [...a.cnes][0]! : null;
    this.cnesDosArquivos[a.idx] = unico;
    const detectado: ArquivoLido = {
      nome: e.nome,
      tipo,
      sistema,
      tipoRegistro,
      tamanhoBytes: e.tamanho,
      registros: a.registros,
      codificacao: leitor.codificacao(),
      origemCodificacao: leitor.origemCodificacao(),
      agravos: [...a.agravos].sort(),
      cnes: unico,
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
    if (porCnes) {
      const k = `${sistema}|${tipoRegistro}`;
      const lista = this.arquivosPorCnes.get(k) ?? [];
      lista.push({ arquivo: detectado, cnes: { cnes: unico ? new Set([unico]) : new Set(), nulo: !unico } });
      this.arquivosPorCnes.set(k, lista);
    }
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
    // A parte deste arquivo e a de outro arquivo do mesmo tipo na lista do registro (uma por tipo de arquivo: a lista é
    // curta).
    let doArquivo = -1;
    let doTipo = -1;
    if (registro !== undefined)
      for (let p = ix.primeira[registro]!; p >= 0; p = ix.prox[p]!) {
        if (ix.arq[p] === a.idx) doArquivo = p;
        else if (this.tiposDosArquivos[ix.arq[p]!] === a.tipo) doTipo = p;
      }
    if (doArquivo >= 0) {
      // Repetida no mesmo arquivo: fica a linha com mais campos preenchidos (empate: a primeira). As linhas de caso do
      // NSURTNET com a planilha junto (NU_CASO) repetem o surto de propósito: não contam como duplicadas.
      const caso = a.tipo === 'NSURTNET' && 'nu_caso' in l;
      let d: AmostraDuplicado | undefined;
      if (!caso) {
        this.duplicadosNoArquivo++;
        if (!ix.repetida[doArquivo]) {
          ix.repetida[doArquivo] = 1;
          a.repetidas++;
        }
        const k = `${a.idx}|${chave}`;
        d = this.amostraRepetidas.get(k);
        if (!d && this.duplicados.length < MAX_AMOSTRAS) {
          d = { chave: plana(reg.chave), arquivo: a.nome, linhas: [ix.linha[doArquivo]!], mantida: ix.linha[doArquivo]! };
          this.duplicados.push(d);
          this.amostraRepetidas.set(k, d);
        }
        if (d && d.linhas.length < MAX_LINHAS_REPETIDA) d.linhas.push(n);
      }
      if (pre > ix.pre[doArquivo]!) {
        const [pos, len] = this.gravarParte(reg);
        ix.pos[doArquivo] = pos;
        ix.len[doArquivo] = len;
        ix.pre[doArquivo] = pre;
        ix.linha[doArquivo] = n;
        if (d) d.mantida = n;
      }
    } else if (doTipo >= 0) {
      // A mesma chave num arquivo anterior do mesmo tipo: fica a deste arquivo (o último), no lugar da outra.
      const [pos, len] = this.gravarParte(reg);
      ix.pos[doTipo] = pos;
      ix.len[doTipo] = len;
      ix.arq[doTipo] = a.idx;
      ix.pre[doTipo] = pre;
      ix.linha[doTipo] = n;
      ix.repetida[doTipo] = 0;
      const rep = this.repetidasEntreArquivos.get(a.tipo);
      if (rep) {
        rep.n++;
        rep.arquivo = a.nome;
      } else this.repetidasEntreArquivos.set(a.tipo, { n: 1, arquivo: a.nome });
    } else {
      const [pos, len] = this.gravarParte(reg);
      const parte = ix.novaParte(pos, len, a.idx, pre, n);
      if (registro !== undefined) ix.encadear(registro, parte);
      else ix.novoRegistro(chave, parte);
    }
    if (reg.agravo && !a.agravos.has(reg.agravo)) a.agravos.add(plana(reg.agravo));
    if (reg.grupo && !a.grupos.has(reg.grupo)) a.grupos.add(plana(reg.grupo));
    // CNES do arquivo (a ficha do e-SUS Notifica sem a síndrome gripal fica fora, como na cobertura).
    if (reg.sistema !== 'ESUS_NOTIFICA' || reg.grupo) {
      a.cobertos++;
      if (!reg.cnes) a.cnesNulo = true;
      else if (a.cnes.size < 2 && !a.cnes.has(reg.cnes)) a.cnes.add(plana(reg.cnes));
    }
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
    leitura.fecharArquivos();
    return leitura;
  } catch (e) {
    leitura.fechar();
    throw e;
  }
}
