import { createWriteStream, statSync } from 'node:fs';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Gunzip } from 'fflate';
import type { RegistroOficialNormalizado } from '@omnisaude/shared';
import type { Cobertura, RegistroDoEnvio } from './leitura';
import { Ritmo } from './ritmo';

/**
 * Payload da prévia (official_imports.payload): os registros normalizados, uma linha JSON por registro, com gzip, para
 * a aplicação ler em lotes. Cada parte vira uma lista na ordem de `ESCALARES` (sem o nome dos campos); a lista das
 * colunas da parte, igual em todas as linhas de um arquivo, vai uma vez só numa linha de tabela. Linhas (v2):
 * `["v",2]`, `["c",i,[colunas]]`, `["r",sistema,tipo,chave,[partes]]` e, no fim, `["f",{cobertura}]`. A v1 (cabeçalho
 * com a cobertura e as colunas, depois um objeto por registro) ainda é lida.
 */

const ESCALARES = [
  'chave',
  'sistema',
  'tipo',
  'tipoArquivo',
  'numero',
  'notificadoEm',
  'semanaNotificacao',
  'municipioNotificacao',
  'cnes',
  'agravo',
  'tipoSuspeita',
  'grupo',
  'inicioSintomas',
  'semanaSintomas',
  'municipioResidencia',
  'bairroCodigo',
  'bairroNome',
  'classificacao',
  'criterio',
  'evolucao',
  'encerradoEm',
  'obitoEm',
  'situacao',
  'gravidade',
  'excluido',
  'sigiloso',
] as const satisfies readonly (keyof RegistroOficialNormalizado)[];
const IDENTIFICACAO = ['nome', 'nascimento', 'sexo', 'mae', 'cns', 'cpf'] as const;
const CONHECIDAS = new Set<string>([...ESCALARES, 'identificacao', 'extras', 'colunas']);

const iguais = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Listas de colunas das partes (uma por arquivo, quase sempre) e as chaves dos extras de cada uma. */
export class TabelaColunas {
  readonly listas: string[][] = [];
  private readonly extras: string[][] = [];
  private readonly porTexto = new Map<string, number>();
  private ultima = -1;

  /** Índice da lista (`nova`: primeira vez que aparece). */
  indice(colunas: readonly string[]): { i: number; nova: boolean } {
    if (this.ultima >= 0 && iguais(this.listas[this.ultima]!, colunas)) return { i: this.ultima, nova: false };
    const texto = colunas.join('\u0001');
    let i = this.porTexto.get(texto);
    const nova = i === undefined;
    if (i === undefined) i = this.registrar(this.listas.length, [...colunas]);
    this.ultima = i;
    return { i, nova };
  }

  registrar(i: number, colunas: string[]): number {
    this.listas[i] = colunas;
    this.extras[i] = colunas.filter((c) => c.startsWith('extras.')).map((c) => c.slice(7));
    this.porTexto.set(colunas.join('\u0001'), i);
    return i;
  }

  chavesExtras(i: number): string[] {
    return this.extras[i] ?? [];
  }
}

/** A parte como lista (`k`: índice da lista de colunas na tabela). */
export function codificarParte(p: RegistroOficialNormalizado, k: number, chavesExtras: readonly string[]): unknown[] {
  const ks = Object.keys(p.extras);
  const alinhado = iguais(ks, chavesExtras);
  const id = p.identificacao;
  const out: unknown[] = [k];
  for (const c of ESCALARES) out.push(p[c]);
  out.push(id ? IDENTIFICACAO.map((c) => id[c]) : null);
  out.push(alinhado ? chavesExtras.map((x) => p.extras[x] ?? null) : p.extras);
  // Campo que não está na lista (o tipo do shared ganhou um campo novo): vai junto, com o nome.
  let resto: Record<string, unknown> | null = null;
  for (const c of Object.keys(p)) if (!CONHECIDAS.has(c)) (resto ??= {})[c] = (p as unknown as Record<string, unknown>)[c];
  if (resto) out.push(resto);
  return out;
}

export function decodificarParte(a: unknown[], tabela: TabelaColunas): RegistroOficialNormalizado {
  const k = a[0] as number;
  const p: Record<string, unknown> = {};
  ESCALARES.forEach((c, i) => (p[c] = a[i + 1] ?? null));
  const id = a[ESCALARES.length + 1] as (string | null)[] | null;
  p.identificacao = id ? Object.fromEntries(IDENTIFICACAO.map((c, i) => [c, id[i] ?? null])) : null;
  const ex = a[ESCALARES.length + 2];
  p.extras = Array.isArray(ex) ? Object.fromEntries(tabela.chavesExtras(k).map((x, i) => [x, ex[i] ?? null])) : (ex ?? {});
  p.colunas = tabela.listas[k] ?? [];
  const resto = a[ESCALARES.length + 3];
  if (resto && typeof resto === 'object') Object.assign(p, resto);
  return p as unknown as RegistroOficialNormalizado;
}

// ───────────── gravação ─────────────

/** Grava o payload em fluxo (gzip em outra thread) num arquivo temporário; `fechar` devolve o tamanho. */
export class EscritorPayload {
  private readonly gz = createGzip({ level: 6 });
  private readonly feito: Promise<void>;
  private readonly tabela = new TabelaColunas();
  registros = 0;

  constructor(readonly caminho: string) {
    this.feito = pipeline(this.gz, createWriteStream(caminho));
    // O erro aparece no `fechar` (e no `escrever`, pelo 'error' do gzip); sem isto ele vira rejeição sem dono.
    this.feito.catch(() => undefined);
    this.gz.write(`${JSON.stringify(['v', 2])}\n`);
  }

  private async gravar(texto: string) {
    if (!this.gz.write(texto)) await once(this.gz, 'drain');
  }

  async escrever(registros: RegistroDoEnvio[]): Promise<void> {
    let texto = '';
    for (const r of registros) {
      const partes = r.partes.map((parte) => {
        const { i, nova } = this.tabela.indice(parte.colunas);
        if (nova) texto += `${JSON.stringify(['c', i, this.tabela.listas[i]])}\n`;
        return codificarParte(parte, i, this.tabela.chavesExtras(i));
      });
      texto += `${JSON.stringify(['r', r.sistema, r.tipo, r.chave, partes])}\n`;
      this.registros++;
    }
    if (texto) await this.gravar(texto);
  }

  async fechar(cobertura: Cobertura[]): Promise<number> {
    await this.gravar(`${JSON.stringify(['f', { cobertura, registros: this.registros }])}\n`);
    this.gz.end();
    await this.feito;
    return statSync(this.caminho).size;
  }

  /** Para a gravação (erro no meio da prévia). */
  abortar() {
    this.gz.destroy();
  }
}

// ───────────── leitura ─────────────

/** Bytes compactados empurrados por vez para o gunzip (o laço de eventos não fica parado num pedaço grande). */
const PASSO_GUNZIP = 16 * 1024;

/**
 * Leitor do payload em lotes, a partir dos pedaços compactados (lidos do banco aos poucos). A cobertura vem no fim (v2)
 * ou no cabeçalho (v1): fica em `cobertura` depois do último lote.
 */
export class LeitorPayload {
  cobertura: Cobertura[] | null = null;
  registros = 0;
  private readonly tabela = new TabelaColunas();
  private versao = 0;
  private readonly ritmo: Ritmo;

  constructor(
    private readonly fonte: AsyncIterable<Uint8Array>,
    ritmo?: Ritmo,
  ) {
    this.ritmo = ritmo ?? new Ritmo();
  }

  /**
   * Os registros em lotes de até `tamanho` registros e `2 × tamanho` partes (o registro que sozinho passa disso vai num
   * lote só dele), como `LeituraEnvio.registros`.
   */
  async *lotes(tamanho = 500): AsyncGenerator<RegistroDoEnvio[]> {
    let lote: RegistroDoEnvio[] = [];
    let partes = 0;
    const prontos: RegistroDoEnvio[][] = [];
    let resto: Buffer | null = null;
    const fecharLote = () => {
      prontos.push(lote);
      lote = [];
      partes = 0;
    };
    const linha = (texto: string) => {
      if (!texto) return;
      const x = JSON.parse(texto) as unknown;
      const r = this.interpretar(x);
      if (!r) return;
      if (lote.length && partes + r.partes.length > tamanho * 2) fecharLote();
      lote.push(r);
      partes += r.partes.length;
      this.registros++;
      if (lote.length >= tamanho) fecharLote();
    };
    const gunzip = new Gunzip((dados) => {
      const b = resto ? Buffer.concat([resto, dados]) : Buffer.from(dados.buffer, dados.byteOffset, dados.byteLength);
      let inicio = 0;
      for (let fim = b.indexOf(0x0a, inicio); fim >= 0; fim = b.indexOf(0x0a, inicio)) {
        linha(b.toString('utf8', inicio, fim));
        inicio = fim + 1;
      }
      resto = inicio < b.length ? Buffer.from(b.subarray(inicio)) : null;
    });
    let algum = false;
    for await (const pedaco of this.fonte) {
      for (let i = 0; i < pedaco.length; i += PASSO_GUNZIP) {
        algum = true;
        gunzip.push(pedaco.subarray(i, i + PASSO_GUNZIP));
        while (prontos.length) {
          yield prontos.shift()!;
          await this.ritmo.ceder();
        }
        await this.ritmo.ceder();
      }
    }
    if (!algum) throw new Error('Payload da prévia vazio');
    gunzip.push(new Uint8Array(0), true);
    if (resto) linha((resto as Buffer).toString('utf8'));
    while (prontos.length) yield prontos.shift()!;
    if (lote.length) yield lote;
    if (!this.cobertura) throw new Error('Payload da prévia sem a cobertura (gravação interrompida)');
  }

  private interpretar(x: unknown): RegistroDoEnvio | null {
    if (Array.isArray(x)) {
      switch (x[0]) {
        case 'v':
          this.versao = x[1] as number;
          return null;
        case 'c':
          this.tabela.registrar(x[1] as number, x[2] as string[]);
          return null;
        case 'f':
          this.cobertura = (x[1] as { cobertura: Cobertura[] }).cobertura;
          return null;
        case 'r':
          return { sistema: x[1], tipo: x[2], chave: x[3], partes: (x[4] as unknown[][]).map((p) => decodificarParte(p, this.tabela)) } as RegistroDoEnvio;
        default:
          throw new Error('Linha desconhecida no payload da prévia');
      }
    }
    // v1: cabeçalho com a cobertura e a tabela das colunas; depois um objeto por registro.
    const o = x as Record<string, unknown>;
    if (this.versao === 0 && o.versao === 1) {
      this.versao = 1;
      this.cobertura = o.cobertura as Cobertura[];
      (o.colunas as string[][]).forEach((c, i) => this.tabela.registrar(i, c));
      return null;
    }
    const r = o as unknown as Omit<RegistroDoEnvio, 'partes'> & { partes: (Omit<RegistroOficialNormalizado, 'colunas'> & { colunas: number })[] };
    return { ...r, partes: r.partes.map((p) => ({ ...p, colunas: this.tabela.listas[p.colunas] ?? [] })) };
  }
}
