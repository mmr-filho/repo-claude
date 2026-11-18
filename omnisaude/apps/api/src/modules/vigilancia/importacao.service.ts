import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TenantPrisma, type MasterClient } from '@omnisaude/database';
import {
  localDateString,
  roleHasPermission,
  type AmostraAlteracao,
  type AmostraRegistro,
  type ArquivoDetectado,
  type ConsultaEnvioImportacao,
  type ContagensImportacao,
  type DetalheImportacao,
  type ErroImportacao,
  type EtapaImportacao,
  type ImportacaoDoMesmoArquivo,
  type ImportacaoSubstituida,
  type ListaImportacoes,
  type PreviaImportacao,
  type RespostaAplicacao,
  type RespostaEnvioImportacao,
  type ResultadoAplicacao,
  type ResultadoDescarte,
  type ResumoImportacao,
  type SistemaOficial,
  type SituacaoCaso,
  type StatusImportacao,
  type TipoRegistroOficial,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB, TenantsService } from '../../core/database';
import { conflict, DomainError, notFound } from '../../core/errors';
import { CargasDoProcesso, MSG_SERVIDOR_OCUPADO } from '../../core/raw-body';
import { coberturaGravada, entradaVazia } from './cobertura-importacao';
import { ConciliacaoService } from './conciliacao.service';
import { gruposSigilosos, grupoDoCidFabrica, municipioDoTenant, municipiosPorNome } from './importacao/apoio';
import { ErroArquivo } from './importacao/dbf';
import { chaveDoEnvio, lerEnvio, MAX_AMOSTRAS, type Cobertura, type LeituraEnvio, type RegistroDoEnvio } from './importacao/leitura';
import { aplicarParte, CAMPOS_IDENTIFICACAO, colunasDoEstado, diferencas, estadoDoBanco, estadoVazio, hashDoEstado, mesmasFontes, SELECT_ESTADO, type EstadoRegistro, type LinhaEstado } from './importacao/mescla';
import { situacaoDoRegistro } from './importacao/normalizar';
import { EscritorPayload, LeitorPayload } from './importacao/payload';
import { Ritmo } from './importacao/ritmo';
import { NegativaService } from './negativa.service';

/**
 * Importação das exportações oficiais (VIG-1c, §4.1; frente F2): lê, detecta, normaliza e grava a PREVIA com as
 * contagens e o payload; aplicar refaz a comparação na transação (upsert pela chave, mescla por campo, ausentes,
 * unidades pelo CNES), roda a conciliação automática e reconcilia a negativa das unidades e semanas tocadas.
 *
 * Memória (container de 1 GiB): o envio é lido em fluxo e comparado em lotes; o payload vai para um arquivo temporário
 * com gzip e daí para o banco em fatias; a aplicação o lê em fatias e em lotes. Uma prévia ou aplicação por vez neste
 * processo: a outra recebe 409. O envio recebe 409 antes de o corpo ser lido quando o tenant tem outra importação lendo
 * ou aplicando (sinal de vida recente, em qualquer processo: IMPORTACAO_OCUPADA, a tela manda acompanhar no histórico)
 * ou quando o processo está ocupado com outros envios (IMPORTACAO_SERVIDOR_OCUPADO, com a mensagem da API): a vez está
 * com a leitura ou a aplicação de outro tenant, o processo já tem `CargasDoProcesso.LIMITE` arquivos na memória (corpo
 * sendo lido ou leitura em segundo plano, de qualquer tenant; o pacote da SIGTAP conta junto) ou o tenant já tem um
 * (`CargasDoProcesso.LIMITE_TENANT`: o outro envio dele ainda chegando). A vez é conferida de novo ao ser tomada, depois
 * do corpo: outro tenant pode tê-la tomado enquanto o arquivo chegava (aí o 409 vem depois de ler). O corpo que para de
 * chegar por 30 s dá 408 (`rawBody`), e a carga é solta.
 *
 * Tempo (container de 1/4 de vCPU; a borda da Cloudflare corta com 524 a resposta que não começa em ~100 s): a leitura
 * e a aplicação rodam em segundo plano no próprio processo, com a vez do processo presa até acabarem. O pedido espera
 * até `esperaMs`: se o trabalho termina, responde como sempre (201 com a prévia, 200 com o resultado, ou o erro de
 * sempre); se não, responde 202 e a tela acompanha pelo detalhe. A linha guarda a etapa (LENDO ou APLICANDO), o sinal
 * de vida, o erro e o resultado da aplicação. Sinal parado há mais de 2 min, sem o trabalho neste processo, é trabalho
 * interrompido (o servidor reiniciou): a leitura vira FALHOU; a aplicação, que é uma transação só, perde a marca sem ter
 * gravado nada.
 */

type Db = TenantPrisma.TransactionClient;
const HORA = 3_600_000;
/** A importação do próprio tenant lendo ou aplicando (aparece no histórico dele). */
const MSG_OCUPADA = 'Outra importação está sendo processada agora. Tente de novo em alguns minutos.';
const MSG_SUBSTITUIDA = 'A importação foi aplicada e depois substituída por uma aplicação do mesmo arquivo com outro período.';
const ERRO_LEITURA_INTERROMPIDA: ErroImportacao = {
  codigo: 'LEITURA_INTERROMPIDA',
  mensagem: 'A leitura do arquivo foi interrompida (o servidor reiniciou). Envie o arquivo de novo.',
};
const ERRO_APLICACAO_INTERROMPIDA: ErroImportacao = {
  codigo: 'APLICACAO_INTERROMPIDA',
  mensagem: 'A aplicação foi interrompida antes de terminar; nada foi gravado. Aplique de novo.',
};
/** Aviso da reconciliação da negativa que não rodou (fica no resultado gravado até ela rodar). */
const AVISO_NEGATIVA_PENDENTE = 'A reconciliação da notificação negativa não rodou agora; o job da vigilância tenta de novo em alguns minutos.';
/**
 * Registros por INSERT. O Prisma 7 guarda os argumentos das últimas 100 chamadas de `debug()` (mesmo com o DEBUG
 * desligado), inclusive o plano de cada consulta: um `createMany` de 500 linhas deixava uns 2 MB presos por chamada (até
 * ~225 MB). Por isso o INSERT é SQL com um parâmetro JSON só, e em lotes pequenos (uns 100 KB por comando).
 */
const LOTE = 250;
/** Registros comparados com o banco por vez (prévia e aplicação). */
const LOTE_COMPARACAO = 500;
/** Linhas por página na contagem dos ausentes e na conciliação dos registros tocados. */
const PAGINA = 5000;
/** Fatia do payload gravada ou lida por comando no banco. */
const FATIA_PAYLOAD = 4 * 1024 * 1024;
/** Fatia do arquivo enviado no cálculo do SHA-256 (o laço de eventos respira entre elas). */
const FATIA_HASH = 4 * 1024 * 1024;

/** Registro do banco com o estado e os campos que a prévia e as listas usam. */
type LinhaBanco = LinhaEstado & { system: string; type: string; naturalKey: string; contentHash: string; absentSince: Date | null; notificationId: string | null };

/** Importação do mesmo arquivo aplicada antes (a que a aplicação substitui), com os ausentes que ela marcou. */
interface AnteriorDoArquivo {
  id: string;
  createdAt: Date;
  appliedAt: Date | null;
  periodFrom: Date | null;
  periodTo: Date | null;
  declaredPeriod: boolean;
  /** Registros com absent_import_id nela, contados antes de gravar os registros deste envio. */
  ausentes: number;
}

/**
 * Outra importação APLICADA com a cobertura dos ausentes gravada no apply_result (`cobertura`): na substituição, o
 * ausente da substituída que ela também cobre, e que não veio desde que ela foi aplicada, continua ausente (R5-2).
 */
interface AplicadaComCobertura {
  id: string;
  aplicadaEm: Date;
  cobertura: Cobertura[];
}

/** Entradas da cobertura de outra aplicação por consulta (o OR de cada consulta não cresce sem limite). */
const COBERTURAS_POR_CONSULTA = 100;

interface Comparado {
  r: RegistroDoEnvio;
  antes: EstadoRegistro;
  depois: EstadoRegistro;
  hash: string;
  linha: LinhaBanco | null;
}

const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** AAAA-MM-DD → DD/MM/AAAA. */
const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const txt = (v: unknown) => (typeof v === 'string' && v ? v : null);
const SINAN: readonly SistemaOficial[] = ['SINAN_NET', 'SINAN_ONLINE'];

/** UUID versão 7 (tempo + aleatório), o mesmo formato que o Prisma gera para o id. */
function uuidv7(): string {
  const b = randomBytes(16);
  const ms = Date.now();
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const diaIso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Colunas do registro como linha do jsonb_to_recordset (datas em AAAA-MM-DD), para o INSERT e o UPDATE em lote. */
function colunasSql(c: Comparado, sensiveis: ReadonlySet<string>) {
  const v = colunasDoEstado(c.r.sistema, c.depois, sensiveis);
  return {
    system: c.r.sistema,
    number: v.number,
    notified_on: diaIso(v.notifiedOn),
    epi_week_notified: v.epiWeekNotified,
    municipality_ibge: v.municipalityIbge,
    unit_cnes: v.unitCnes,
    agravo: v.agravo,
    suspected_type: v.suspectedType,
    group_key: v.groupKey,
    symptoms_onset: diaIso(v.symptomsOnset),
    epi_week_onset: v.epiWeekOnset,
    residence_ibge: v.residenceIbge,
    neighborhood_code: v.neighborhoodCode,
    neighborhood_name: v.neighborhoodName,
    final_class: v.finalClass,
    criterion: v.criterion,
    evolution: v.evolution,
    closed_on: diaIso(v.closedOn),
    death_on: diaIso(v.deathOn),
    situation: v.situation,
    severity: v.severity,
    excluded: v.excluded,
    sensitive: v.sensitive,
    patient_name: v.patientName,
    patient_name_norm: v.patientNameNorm,
    birth_date: diaIso(v.birthDate),
    sex: v.sex,
    mother_name_norm: v.motherNameNorm,
    cns: v.cns,
    cpf: v.cpf,
    data: v.data,
    content_hash: c.hash,
  };
}

/** Data de calendário que existe (ida e volta pelo Date.UTC: 2025-13-01 e 2025-02-30 não passam). */
function dataExiste(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(a, mes - 1, d));
  return a >= 1900 && t.getUTCFullYear() === a && t.getUTCMonth() === mes - 1 && t.getUTCDate() === d;
}

/**
 * Filtro dos registros do banco dentro de uma entrada da cobertura (sistema, tipo, período, agravos, municípios, ficha e
 * CNES), ausentes ou não. É de dois valores (dá verdadeiro ou falso, nunca nulo): cada condição sobre coluna anulável
 * (CNES, município, agravo e ficha) leva a guarda de não nulo. Sem ela, `unit_cnes IN (...)` dá NULL no registro sem
 * CNES (lógica de três valores do SQL), o NOT de `foraDe` também dá NULL, e o registro sem CNES, sem município, sem
 * agravo ou sem ficha sumia da prévia, que deixava de bater com a aplicação (R6-1).
 */
function cobertoPor(c: Cobertura): TenantPrisma.OfficialRecordWhereInput {
  const agravos = c.agravos.filter((a): a is string => !!a);
  return {
    system: c.sistema,
    type: c.tipo,
    notifiedOn: { gte: new Date(`${c.de}T00:00:00Z`), lte: new Date(`${c.ate}T00:00:00Z`) },
    ...(c.grupos ? { groupKey: { in: c.grupos, not: null } } : {}),
    ...(c.cnes ? { unitCnes: { in: c.cnes, not: null } } : {}),
    AND: [
      { OR: [...(agravos.length ? [{ agravo: { in: agravos, not: null } }] : []), ...(c.agravos.includes(null) ? [{ agravo: null }] : [])] },
      { OR: [...c.municipios.map((m) => ({ municipalityIbge: { startsWith: m, not: null } })), ...(c.municipioNulo ? [{ municipalityIbge: null }] : [])] },
    ],
  };
}

/** A entrada da cobertura que não cobre nada (a ficha do e-SUS Notifica sem grupo, de envios antigos). */
const vazia = entradaVazia;

const cruzam = <T>(a: readonly T[], b: readonly T[]) => a.some((x) => b.includes(x));

/**
 * As duas entradas da cobertura podem cobrir o mesmo registro (a do município e a de uma unidade no mesmo período; dois
 * arquivos com períodos que se cruzam). A prévia não conta o registro duas vezes: a entrada exclui o que as anteriores
 * que se cruzam com ela já contaram.
 */
function podemSeCruzar(a: Cobertura, b: Cobertura): boolean {
  return (
    a.sistema === b.sistema &&
    a.tipo === b.tipo &&
    a.de <= b.ate &&
    b.de <= a.ate &&
    cruzam(a.agravos, b.agravos) &&
    (!a.grupos || !b.grupos || cruzam(a.grupos, b.grupos)) &&
    (!a.cnes || !b.cnes || cruzam(a.cnes, b.cnes)) &&
    (cruzam(a.municipios, b.municipios) || (a.municipioNulo && b.municipioNulo))
  );
}

/**
 * Fora das entradas `antes` (o NOT de um OR; sem entradas, nada a excluir). Verdadeiro para o registro que nenhuma delas
 * cobre, com CNES, município, agravo ou ficha nulos inclusive: `cobertoPor` é de dois valores.
 */
const foraDe = (antes: readonly Cobertura[]): TenantPrisma.OfficialRecordWhereInput => (antes.length ? { NOT: { OR: antes.map(cobertoPor) } } : {});

/** O resultado da aplicação como a API mostra: sem a cobertura gravada (é do servidor, e um zip de muitas unidades a deixa longa). */
function resultadoSemCobertura(applyResult: unknown): ResultadoAplicacao | null {
  if (!applyResult || typeof applyResult !== 'object') return null;
  const { cobertura: _cobertura, ...resultado } = applyResult as ResultadoAplicacao & { cobertura?: unknown };
  return resultado;
}

/** Leitura ou aplicação rodando em segundo plano neste processo. */
interface Trabalho {
  id: string;
  etapa: EtapaImportacao;
  /** O pedido deixou de esperar (respondeu 202): a falha passa a ser gravada na linha. */
  abandonado: boolean;
  /** Termina quando o trabalho acaba de vez (com a falha gravada ou desfeita, o sinal parado e a vez devolvida). */
  fim: Promise<void>;
}

/**
 * Estado deste processo (cada réplica da API e o worker dos jobs têm o seu). Os arquivos na memória ficam em
 * `CargasDoProcesso` (core/raw-body), que o upload da SIGTAP também usa.
 */
class Processo {
  /** Uma prévia ou aplicação por vez (o envio grande ocupa a memória e a CPU do container). */
  ocupado = false;
  /** O tenant da importação que está com a vez (null: a vez tomada sem tenant, como nos testes). */
  donoDaVez: string | null = null;
  /** Trabalhos em segundo plano, pelo id da importação: o sinal de vida parado de um deles não é trabalho interrompido. */
  readonly trabalhos = new Map<string, Trabalho>();
}

/** Fim de todos os trabalhos em segundo plano, de qualquer `Processo` (os testes esperam antes de fechar a API). */
const fins = new Set<Promise<void>>();

/** Momento do trabalho em que o gancho dos testes roda: no começo, ou na aplicação depois de gravar os registros. */
export type MomentoDoGancho = 'INICIO' | 'GRAVADO';

type Desfecho<T> = { ok: true; valor: T } | { ok: false; erro: unknown };

@Injectable()
export class ImportacaoService {
  /** Fatia do payload por comando no banco (os testes diminuem para passar por várias). */
  static fatiaPayload = FATIA_PAYLOAD;
  /** Quanto o pedido espera o trabalho em segundo plano antes de responder 202 (os testes mudam). */
  static esperaMs = 20_000;
  /** Intervalo do sinal de vida do trabalho em segundo plano (os testes diminuem). */
  static sinalMs = 15_000;
  /** Sinal de vida mais velho que isto, sem o trabalho neste processo: o trabalho foi interrompido (os testes diminuem). */
  static sinalParadoMs = 2 * 60_000;
  /**
   * Só para os testes: roda no trabalho em segundo plano (no começo da leitura; na aplicação, no começo da transação e
   * depois de gravar os registros, com a linha da importação presa pelas chaves estrangeiras), para segurá-lo ou simular
   * uma falha.
   */
  static ganchoDeTeste: ((etapa: EtapaImportacao, id: string, momento: MomentoDoGancho) => Promise<void>) | null = null;
  /** O estado deste processo (só os testes trocam, por `comoOutroProcesso`). */
  private static processo = new Processo();
  private readonly logger = new Logger('Importacao');

  constructor(
    private readonly audit: AuditService,
    private readonly conciliacao: ConciliacaoService,
    private readonly moduleRef: ModuleRef,
    private readonly tenants: TenantsService,
    @Inject(MASTER_DB) private readonly master: MasterClient,
  ) {}

  /** O NegativaService pela referência do módulo (sem ciclo de injeção com o job 'vigilancia'). */
  private negativas(): NegativaService {
    return this.moduleRef.get(NegativaService, { strict: false });
  }

  /**
   * Confere a vez do processo para o tenant sem tomá-la; com outra prévia ou aplicação em andamento, 409:
   * IMPORTACAO_OCUPADA quando é a importação do mesmo tenant (aparece no histórico dele), IMPORTACAO_SERVIDOR_OCUPADO
   * quando é a de outro tenant (ou a vez sem tenant). O envio confere antes de reservar a carga e de ler o corpo.
   */
  private conferirVez(p: Processo, tenantId: string | null): void {
    if (!p.ocupado) return;
    if (tenantId && p.donoDaVez === tenantId) throw new DomainError('IMPORTACAO_OCUPADA', MSG_OCUPADA, HttpStatus.CONFLICT);
    throw new DomainError('IMPORTACAO_SERVIDOR_OCUPADO', MSG_SERVIDOR_OCUPADO, HttpStatus.CONFLICT);
  }

  /** Toma a vez do processo para o tenant (com a vez ocupada, os 409 de `conferirVez`). */
  private tomarVez(p: Processo, tenantId: string | null): void {
    this.conferirVez(p, tenantId);
    p.ocupado = true;
    p.donoDaVez = tenantId;
  }

  private devolverVez(p: Processo): void {
    p.ocupado = false;
    p.donoDaVez = null;
  }

  /** Roda `fn` sozinho neste processo; com outra prévia ou aplicação em andamento, 409 (os testes seguram a vez assim). */
  private async exclusivo<T>(fn: () => Promise<T>): Promise<T> {
    const p = ImportacaoService.processo;
    this.tomarVez(p, null);
    try {
      return await fn();
    } finally {
      this.devolverVez(p);
    }
  }

  /** Outra importação do tenant lendo ou aplicando agora (sinal de vida recente, em qualquer processo): 409. */
  private async conferirEmAndamento(db: Db): Promise<void> {
    const viva = await db.officialImport.findFirst({
      where: { workingStep: { not: null }, workingAt: { gte: new Date(Date.now() - ImportacaoService.sinalParadoMs) } },
      select: { id: true },
    });
    if (viva) throw new DomainError('IMPORTACAO_OCUPADA', MSG_OCUPADA, HttpStatus.CONFLICT);
  }

  /** Espera os trabalhos em segundo plano acabarem (os testes, antes de fechar a API). */
  static async aguardarTrabalhos(): Promise<void> {
    await Promise.allSettled([...fins]);
  }

  /** Arquivos na memória deste processo agora (importação e SIGTAP; os testes esperam por aqui). */
  static get cargas(): number {
    return CargasDoProcesso.atual.total;
  }

  /**
   * Só para os testes: daqui em diante este processo faz o papel de outro (outra réplica da API ou o worker dos jobs),
   * sem a vez, as cargas nem os trabalhos de antes, que seguem no estado antigo até acabar. Devolve a volta.
   */
  static comoOutroProcesso(): () => void {
    const antes = ImportacaoService.processo;
    const cargasAntes = CargasDoProcesso.atual;
    ImportacaoService.processo = new Processo();
    CargasDoProcesso.atual = new CargasDoProcesso();
    return () => {
      ImportacaoService.processo = antes;
      CargasDoProcesso.atual = cargasAntes;
    };
  }

  // ───────────────────────────── segundo plano ─────────────────────────────

  /**
   * Roda `trabalho` em segundo plano, com a vez do processo (tomada por quem chama) presa até ele acabar, o sinal de vida
   * da linha e o registro deste processo, e espera até `esperaMs`. Devolve o desfecho quando o trabalho acaba dentro da
   * espera (falhou: `falha.desfazer` já rodou), ou null quando continua: o pedido responde 202 e, se falhar depois,
   * `falha.registrar` grava a falha na linha. `aoTerminar` roda uma vez, quando o trabalho acaba de vez (a leitura solta
   * a carga do arquivo na memória). O que vem do pedido e é usado depois (sessão, IP, configurações do tenant, banco) é
   * um objeto comum, sem nada que o fim da resposta feche (não há interceptor nem provedor por pedido): o banco é o pool
   * do tenant no processo, que o sinal de vida mantém entre os abertos.
   */
  private async emSegundoPlano<T>(
    p: Processo,
    db: Db,
    tenantId: string,
    id: string,
    etapa: EtapaImportacao,
    trabalho: () => Promise<T>,
    falha: { desfazer: () => Promise<unknown>; registrar: (erro: ErroImportacao) => Promise<unknown> },
    aoTerminar?: () => void,
  ): Promise<Desfecho<T> | null> {
    // `as`: o desfecho é escrito pelas funções de baixo (sem ele, o TypeScript o daria como sempre null).
    let desfecho = null as Desfecho<T> | null;
    const t: Trabalho = { id, etapa, abandonado: false, fim: Promise.resolve() };
    p.trabalhos.set(id, t);
    const sinal = this.sinalDeVida(db, tenantId, id, etapa);
    const terminou = (async () => {
      try {
        desfecho = { ok: true, valor: await trabalho() };
      } catch (erro) {
        desfecho = { ok: false, erro };
      }
    })();
    // Registrado antes da espera: roda antes dela ao terminar, então `abandonado` aqui e lá é o mesmo.
    t.fim = terminou
      .then(async () => {
        const d = desfecho;
        if (!d || d.ok) return;
        try {
          if (t.abandonado) await falha.registrar(this.erroGravado(d.erro, etapa));
          else await falha.desfazer();
        } catch (e) {
          this.logger.error(`Importação ${id}: não deu para gravar a falha da ${etapa === 'LENDO' ? 'leitura' : 'aplicação'}: ${(e as Error).message}`);
        }
      })
      .finally(() => {
        sinal.parar();
        p.trabalhos.delete(id);
        this.devolverVez(p);
        aoTerminar?.();
        fins.delete(t.fim);
      });
    fins.add(t.fim);
    let espera: NodeJS.Timeout | undefined;
    await Promise.race([terminou, new Promise<void>((ok) => (espera = setTimeout(ok, ImportacaoService.esperaMs)))]);
    clearTimeout(espera);
    if (desfecho) {
      await t.fim;
      return desfecho;
    }
    t.abandonado = true;
    return null;
  }

  /**
   * Sinal de vida do trabalho: atualiza working_at a cada `sinalMs`, só na linha com a mesma etapa e o status do
   * trabalho (nunca na linha já concluída) e sem esperar a linha travada pela transação do próprio trabalho. Também usa o
   * banco do tenant pelo gerenciador de conexões: o pool usado há mais tempo é o que fecha quando passa do teto de
   * tenants abertos, e o do trabalho não pode fechar no meio dele.
   *
   * A trava é FOR NO KEY UPDATE: a transação da aplicação, a partir do primeiro INSERT ou UPDATE em official_records,
   * segura a linha da importação com FOR KEY SHARE (as chaves estrangeiras first_import_id e last_import_id), que só
   * conflita com FOR UPDATE. Com FOR UPDATE SKIP LOCKED o sinal parava ali, e outro processo (a outra réplica, o worker
   * dos jobs) dava a aplicação longa como interrompida. O UPDATE de working_at não muda chave, então também não espera.
   * A linha só fica pulada no fim da transação do próprio trabalho, quando ele muda o status dela.
   */
  private sinalDeVida(db: Db, tenantId: string, id: string, etapa: EtapaImportacao): { parar(): void } {
    let parado = false;
    let timer: NodeJS.Timeout | undefined;
    const agendar = () => {
      if (parado) return;
      timer = setTimeout(() => void bater(), ImportacaoService.sinalMs);
      timer.unref();
    };
    const bater = async () => {
      try {
        await this.tenants.client(tenantId).catch(() => undefined);
        await db.$executeRaw`
          UPDATE official_imports SET working_at = ${new Date().toISOString()}::timestamptz AT TIME ZONE 'UTC'
          WHERE id IN (
            SELECT id FROM official_imports
            WHERE id = ${id}::uuid AND working_step = ${etapa}
              AND (CASE WHEN working_step = 'LENDO' THEN status = 'PROCESSANDO' ELSE status IN ('PREVIA', 'APLICADA', 'SUBSTITUIDA') END)
            FOR NO KEY UPDATE SKIP LOCKED)`;
      } catch (e) {
        this.logger.warn(`Sinal de vida da importação ${id}: ${(e as Error).message}`);
      }
      agendar();
    };
    agendar();
    return {
      parar: () => {
        parado = true;
        clearTimeout(timer);
      },
    };
  }

  /**
   * Trabalho com o sinal de vida parado há mais de 2 min, que não roda neste processo, foi interrompido (o servidor
   * reiniciou): a leitura vira FALHOU; a aplicação perde a marca e, na PREVIA, ganha o erro (a transação não terminou,
   * nada foi gravado; na APLICADA, só faltou a reconciliação da negativa, que o job faz). Roda na lista, no detalhe, ao
   * aplicar e descartar, e no job das prévias vencidas.
   */
  private async recuperarInterrompidos(db: Db, id?: string): Promise<number> {
    const limite = new Date(Date.now() - ImportacaoService.sinalParadoMs).toISOString();
    const meus = [...ImportacaoService.processo.trabalhos.keys()];
    const so = id ? TenantPrisma.sql`AND id = ${id}::uuid` : TenantPrisma.empty;
    const leitura = await db.$executeRaw`
      UPDATE official_imports SET status = 'FALHOU', error = ${JSON.stringify(ERRO_LEITURA_INTERROMPIDA)}::jsonb, working_step = NULL, working_since = NULL,
        working_at = NULL, payload = NULL, preview = NULL
      WHERE status = 'PROCESSANDO' AND working_at < ${limite}::timestamptz AT TIME ZONE 'UTC' AND NOT (id = ANY(${meus}::uuid[])) ${so}`;
    const aplicacao = await db.$executeRaw`
      UPDATE official_imports SET working_step = NULL, working_since = NULL, working_at = NULL,
        error = CASE WHEN status = 'PREVIA' THEN ${JSON.stringify(ERRO_APLICACAO_INTERROMPIDA)}::jsonb ELSE error END
      WHERE working_step = 'APLICANDO' AND working_at < ${limite}::timestamptz AT TIME ZONE 'UTC' AND NOT (id = ANY(${meus}::uuid[])) ${so}`;
    if (leitura + aplicacao) this.logger.warn(`Importações interrompidas: ${leitura} leitura(s) e ${aplicacao} aplicação(ões) com o sinal de vida parado.`);
    return leitura + aplicacao;
  }

  /** Erro como fica gravado na linha: o código e a mensagem da resposta de erro; o erro inesperado vai para o log. */
  private erroGravado(e: unknown, etapa: EtapaImportacao): ErroImportacao {
    if (e instanceof DomainError) return JSON.parse(JSON.stringify({ codigo: e.code, mensagem: e.message, detalhes: e.details })) as ErroImportacao;
    this.logger.error(`${etapa === 'LENDO' ? 'Leitura' : 'Aplicação'} da importação em segundo plano: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return etapa === 'LENDO'
      ? { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno ao ler o arquivo. Envie de novo; se o erro se repetir, avise o suporte.' }
      : { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno ao aplicar; nada foi gravado. Aplique de novo; se o erro se repetir, avise o suporte.' };
  }

  /** Tira a marca da aplicação; na PREVIA, grava o erro (null: sem erro, a falha foi respondida ao pedido). */
  private async limparMarcaDaAplicacao(db: Db, id: string, erro: ErroImportacao | null): Promise<void> {
    await db.$executeRaw`
      UPDATE official_imports SET working_step = NULL, working_since = NULL, working_at = NULL,
        error = CASE WHEN status = 'PREVIA' THEN ${erro ? JSON.stringify(erro) : null}::jsonb ELSE error END
      WHERE id = ${id}::uuid AND working_step = 'APLICANDO'`;
  }

  // ───────────────────────────── comparação com o banco ─────────────────────────────

  /**
   * Registros do banco com a mesma chave (sistema, tipo e chave natural) dos registros do envio. No Sinan, procura a
   * chave nos dois sistemas (Net e Online): o registro gravado no outro sistema é o mesmo e muda de sistema na aplicação.
   * Se a chave estiver nos dois (gravados antes da regra da dengue e da chikungunya), vale o do próprio sistema.
   */
  private async existentes(db: Db, registros: RegistroDoEnvio[]): Promise<{ mapa: Map<string, LinhaBanco>; nosDoisSistemas: number }> {
    const porGrupo = new Map<string, { sistemas: SistemaOficial[]; tipo: TipoRegistroOficial; chaves: string[] }>();
    for (const r of registros) {
      const sinan = SINAN.includes(r.sistema);
      const k = `${sinan ? 'SINAN' : r.sistema}|${r.tipo}`;
      const g = porGrupo.get(k) ?? { sistemas: sinan ? [...SINAN] : [r.sistema], tipo: r.tipo, chaves: [] };
      g.chaves.push(r.chave);
      porGrupo.set(k, g);
    }
    const porChave = new Map<string, LinhaBanco[]>();
    for (const g of porGrupo.values())
      for (let i = 0; i < g.chaves.length; i += 2000) {
        const rows = await db.officialRecord.findMany({ where: { system: { in: g.sistemas }, type: g.tipo, naturalKey: { in: g.chaves.slice(i, i + 2000) } }, select: SELECT_ESTADO });
        for (const row of rows) {
          const k = `${SINAN.includes(row.system) ? 'SINAN' : row.system}|${row.type}|${row.naturalKey}`;
          const lista = porChave.get(k);
          if (lista) lista.push(row as LinhaBanco);
          else porChave.set(k, [row as LinhaBanco]);
        }
      }
    const mapa = new Map<string, LinhaBanco>();
    let nosDoisSistemas = 0;
    for (const r of registros) {
      const linhas = porChave.get(`${SINAN.includes(r.sistema) ? 'SINAN' : r.sistema}|${r.tipo}|${r.chave}`);
      if (!linhas) continue;
      if (linhas.length > 1) nosDoisSistemas++;
      mapa.set(chaveDoEnvio(r.sistema, r.tipo, r.chave), linhas.find((l) => l.system === r.sistema) ?? linhas[0]!);
    }
    return { mapa, nosDoisSistemas };
  }

  /** Estado de cada registro do envio depois da mescla, com o estado anterior do banco. */
  private comparar(registros: RegistroDoEnvio[], existentes: Map<string, LinhaBanco>): Comparado[] {
    return registros.map((r) => {
      const linha = existentes.get(chaveDoEnvio(r.sistema, r.tipo, r.chave)) ?? null;
      const antes = linha ? estadoDoBanco(linha) : estadoVazio();
      const depois = r.partes.reduce(aplicarParte, antes);
      return { r, antes, depois, hash: hashDoEstado(r.sistema, r.tipo, depois), linha };
    });
  }

  /** Os registros presentes (não ausentes) dentro de uma entrada da cobertura. */
  private ondeCobertura(c: Cobertura): TenantPrisma.OfficialRecordWhereInput {
    return { ...cobertoPor(c), absentSince: null };
  }

  /**
   * Prévia: quantos registros do banco dentro da cobertura não vieram no envio (em páginas), com a amostra. A cobertura
   * é uma lista por arquivo: a entrada exclui o que as anteriores que se cruzam com ela já contaram (o registro dentro de
   * duas entradas conta uma vez, como na aplicação).
   */
  private async ausentesPrevistos(db: Db, cobertura: Cobertura[], leitura: LeituraEnvio, ritmo: Ritmo): Promise<{ total: number; amostra: AmostraRegistro[] }> {
    let total = 0;
    const amostra: AmostraRegistro[] = [];
    const entradas = cobertura.filter((c) => !vazia(c));
    for (const [i, c] of entradas.entries()) {
      const antes = foraDe(entradas.slice(0, i).filter((o) => podemSeCruzar(o, c)));
      let depois: string | null = null;
      for (;;) {
        const rows: {
          id: string;
          system: string;
          type: string;
          naturalKey: string;
          number: string;
          notifiedOn: Date;
          agravo: string | null;
          groupKey: string | null;
          unitCnes: string | null;
          situation: string;
          patientName: string | null;
          sensitive: boolean;
        }[] = await db.officialRecord.findMany({
          where: { ...this.ondeCobertura(c), ...antes, ...(depois ? { id: { gt: depois } } : {}) },
          orderBy: { id: 'asc' },
          take: PAGINA,
          select: { id: true, system: true, type: true, naturalKey: true, number: true, notifiedOn: true, agravo: true, groupKey: true, unitCnes: true, situation: true, patientName: true, sensitive: true },
        });
        for (const a of rows) {
          if (leitura.tem(chaveDoEnvio(a.system, a.type, a.naturalKey))) continue;
          total++;
          if (amostra.length < MAX_AMOSTRAS)
            amostra.push({
              chave: a.naturalKey,
              tipo: a.type as TipoRegistroOficial,
              numero: a.number,
              notificadoEm: dia(a.notifiedOn)!,
              agravo: a.agravo,
              grupo: a.groupKey,
              cnes: a.unitCnes,
              situacao: a.situation as SituacaoCaso,
              paciente: a.patientName,
              sigiloso: a.sensitive,
            });
        }
        if (rows.length < PAGINA) break;
        depois = rows[rows.length - 1]!.id;
        await ritmo.ceder();
      }
    }
    return { total, amostra };
  }

  /**
   * Aplicação: marca os ausentes da cobertura (os registros que este envio não tocou), com a importação que marcou
   * (absent_import_id: se ela for substituída, o registro volta, a menos que outra aplicação confirme a ausência). Nunca
   * apaga. A entrada que se cruza com outra não marca de novo o que a outra marcou (só os presentes são marcados).
   */
  private async marcarAusentes(tx: Db, cobertura: Cobertura[], id: string, agora: Date): Promise<number> {
    let total = 0;
    for (const c of cobertura) {
      if (vazia(c)) continue;
      const { count } = await tx.officialRecord.updateMany({ where: { ...this.ondeCobertura(c), lastImportId: { not: id } }, data: { absentSince: agora, absentImportId: id } });
      total += count;
    }
    return total;
  }

  /**
   * As outras importações APLICADA com a cobertura gravada (as que podem confirmar um ausente), da aplicada mais recente
   * para a mais antiga. `exceto`: os ids que não contam (na aplicação, a própria); `shaExceto`: o SHA-256 que não conta
   * (na prévia, o do próprio arquivo: as aplicações dele vão ser substituídas). A aplicação gravada sem a cobertura (de
   * antes da regra, a demonstração) não confirma nada.
   */
  private async aplicadasComCobertura(db: Db, opts: { exceto: string[]; shaExceto?: string }): Promise<AplicadaComCobertura[]> {
    const rows = await db.officialImport.findMany({
      where: { status: 'APLICADA', appliedAt: { not: null }, id: { notIn: opts.exceto }, ...(opts.shaExceto ? { sha256: { not: opts.shaExceto } } : {}) },
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, appliedAt: true, applyResult: true },
    });
    return rows.flatMap((r) => {
      const cobertura = coberturaGravada(r.applyResult).filter((c) => !vazia(c));
      return cobertura.length ? [{ id: r.id, aplicadaEm: r.appliedAt!, cobertura }] : [];
    });
  }

  /**
   * O ausente que a outra aplicação `k` confirma: ela foi aplicada depois da última vez que o registro veio (então não o
   * trouxe) e a cobertura dela inclui o registro. `lote`: uma fatia das entradas da cobertura dela.
   */
  private confirmadoPor(k: AplicadaComCobertura, lote: readonly Cobertura[]): TenantPrisma.OfficialRecordWhereInput {
    return { lastSeenAt: { lt: k.aplicadaEm }, OR: lote.map(cobertoPor) };
  }

  /**
   * Prévia: os registros que a importação `anterior` (do mesmo arquivo, que este envio vai substituir) deu como ausentes
   * e voltam ao aplicar, em termos líquidos: todos os dela, menos os que a cobertura deste envio marca de novo (dentro
   * dela e fora do arquivo) e menos os que outra importação APLICADA (de outro arquivo, aplicada depois da última vez que
   * o registro veio) confirma, como a aplicação faz (`substituirAnteriores`).
   */
  private async voltamDaSubstituicao(db: Db, anterior: string, cobertura: Cobertura[], outras: AplicadaComCobertura[], leitura: LeituraEnvio, ritmo: Ritmo): Promise<number> {
    let voltam = await db.officialRecord.count({ where: { absentImportId: anterior } });
    if (!voltam) return 0;
    type Linha = { id: string; system: string; type: string; naturalKey: string };
    const select = { id: true, system: true, type: true, naturalKey: true } as const;
    const entradas = cobertura.filter((c) => !vazia(c));
    for (const [i, c] of entradas.entries()) {
      const antes = foraDe(entradas.slice(0, i).filter((o) => podemSeCruzar(o, c)));
      for (let depois: string | null = null; ; ) {
        const rows: Linha[] = await db.officialRecord.findMany({
          where: { ...cobertoPor(c), ...antes, absentImportId: anterior, ...(depois ? { id: { gt: depois } } : {}) },
          orderBy: { id: 'asc' },
          take: PAGINA,
          select,
        });
        for (const a of rows) if (!leitura.tem(chaveDoEnvio(a.system, a.type, a.naturalKey))) voltam--;
        if (rows.length < PAGINA) break;
        depois = rows[rows.length - 1]!.id;
        await ritmo.ceder();
      }
    }
    // Os de fora da cobertura deste envio (e fora do arquivo) que outra aplicação confirma continuam ausentes.
    const confirmados = new Set<string>();
    const fora = foraDe(entradas);
    for (const k of outras)
      for (let i = 0; i < k.cobertura.length; i += COBERTURAS_POR_CONSULTA)
        for (let depois: string | null = null; ; ) {
          const rows: Linha[] = await db.officialRecord.findMany({
            where: { absentImportId: anterior, ...fora, AND: [this.confirmadoPor(k, k.cobertura.slice(i, i + COBERTURAS_POR_CONSULTA))], ...(depois ? { id: { gt: depois } } : {}) },
            orderBy: { id: 'asc' },
            take: PAGINA,
            select,
          });
          for (const a of rows)
            if (!confirmados.has(a.id) && !leitura.tem(chaveDoEnvio(a.system, a.type, a.naturalKey))) {
              confirmados.add(a.id);
              voltam--;
            }
          if (rows.length < PAGINA) break;
          depois = rows[rows.length - 1]!.id;
          await ritmo.ceder();
        }
    return Math.max(0, voltam);
  }

  /**
   * Aplicação (na transação, com as travas, depois de gravar os registros do arquivo e antes de marcar os ausentes): as
   * outras aplicações do mesmo arquivo (`anteriores`, APLICADA) passam a SUBSTITUIDA, com superseded_by = esta. Dos
   * registros que elas deram como ausentes:
   * - os que a cobertura desta marca de novo (dentro dela e não tocados por este envio) continuam ausentes, agora por
   *   esta, com o absent_since de quando sumiram;
   * - os de fora dela continuam ausentes quando outra importação APLICADA (qualquer arquivo, aplicada antes ou depois da
   *   substituída, nunca ela nem esta) foi aplicada depois da última vez que o registro veio e tem cobertura que o inclui:
   *   a exportação mais nova do período também não o traz. A marca passa para a mais recente delas (pelo applied_at),
   *   com o absent_since mantido. A aplicação gravada sem a cobertura não confirma;
   * - os outros voltam (absent_since e absent_import_id nulos).
   * Devolve, por substituída, quantos voltaram em termos líquidos (os dela que deixaram de estar ausentes, os que vieram
   * no arquivo inclusive), e as unidades e semanas dos que voltaram agora (a negativa delas é reconciliada junto com a
   * dos registros do arquivo).
   */
  private async substituirAnteriores(tx: Db, anteriores: AnteriorDoArquivo[], cobertura: Cobertura[], id: string, agora: Date): Promise<{ substituidas: ImportacaoSubstituida[]; unidades: string[]; semanas: string[] }> {
    const unidades = new Set<string>();
    const semanas = new Set<string>();
    if (!anteriores.length) return { substituidas: [], unidades: [], semanas: [] };
    const { count } = await tx.officialImport.updateMany({ where: { id: { in: anteriores.map((a) => a.id) }, status: 'APLICADA' }, data: { status: 'SUBSTITUIDA', supersededBy: id } });
    if (count !== anteriores.length) throw conflict('A importação mudou: abra de novo');
    // As que podem confirmar (as substituídas já não são APLICADA; esta ainda é PREVIA), lidas só se alguma tem ausente.
    let outras: AplicadaComCobertura[] | null = null;
    const substituidas: ImportacaoSubstituida[] = [];
    for (const a of anteriores) {
      let continuam = 0;
      for (const c of cobertura) {
        if (vazia(c)) continue;
        const r = await tx.officialRecord.updateMany({ where: { ...cobertoPor(c), absentImportId: a.id, lastImportId: { not: id } }, data: { absentImportId: id } });
        continuam += r.count;
      }
      let confirmados = 0;
      let restam = await tx.officialRecord.count({ where: { absentImportId: a.id } });
      if (restam) outras ??= await this.aplicadasComCobertura(tx, { exceto: [id] });
      for (const k of restam ? outras! : [])
        for (let i = 0; restam && i < k.cobertura.length; i += COBERTURAS_POR_CONSULTA) {
          const r = await tx.officialRecord.updateMany({
            where: { absentImportId: a.id, AND: [this.confirmadoPor(k, k.cobertura.slice(i, i + COBERTURAS_POR_CONSULTA))] },
            data: { absentImportId: k.id },
          });
          confirmados += r.count;
          restam -= r.count;
        }
      const voltas = await tx.$queryRaw<{ u: string | null; s: string | null }[]>`
        WITH v AS (
          UPDATE official_records SET absent_since = NULL, absent_import_id = NULL, updated_at = ${agora.toISOString()}::timestamptz AT TIME ZONE 'UTC'
          WHERE absent_import_id = ${a.id}::uuid
          RETURNING unit_id, epi_week_notified)
        SELECT DISTINCT unit_id::text AS u, trim(epi_week_notified) AS s FROM v WHERE unit_id IS NOT NULL`;
      for (const v of voltas) {
        unidades.add(v.u!);
        if (v.s) semanas.add(v.s);
      }
      substituidas.push({ ...this.doMesmoArquivo(a), voltaram: Math.max(0, a.ausentes - continuam - confirmados) });
    }
    return { substituidas, unidades: [...unidades], semanas: [...semanas] };
  }

  private amostra(c: Comparado): AmostraRegistro {
    const v = c.depois.valores;
    const agravo = txt(v.agravo);
    return {
      chave: c.r.chave,
      tipo: c.r.tipo,
      numero: txt(v.numero) ?? c.r.partes[0]!.numero,
      notificadoEm: txt(v.notificadoEm) ?? c.r.partes[0]!.notificadoEm,
      agravo,
      grupo: txt(v.grupo),
      cnes: txt(v.cnes),
      situacao: situacaoDoRegistro(c.r.sistema, agravo, txt(v.classificacao), txt(v.criterio)),
      paciente: txt(v.nome),
      sigiloso: c.r.partes.some((p) => p.sigiloso),
    };
  }

  // ───────────────────────────── envio ─────────────────────────────

  private async sha256(arquivo: Buffer, ritmo: Ritmo): Promise<string> {
    const h = createHash('sha256');
    for (let i = 0; i < arquivo.length; i += FATIA_HASH) {
      h.update(arquivo.subarray(i, i + FATIA_HASH));
      await ritmo.ceder();
    }
    return h.digest('hex');
  }

  /**
   * A aplicação do mesmo arquivo que já vale para este envio: sem período declarado, a aplicação do arquivo (qualquer
   * período); com período declarado, só a aplicação com o mesmo período declarado. Outro período gera prévia nova: é
   * como se corrige o período depois de aplicado (o lido das notificações, ou um declarado errado). Aplicada, ela
   * substitui a anterior (SUBSTITUIDA, que não conta aqui): vale só a aplicação mais recente do arquivo. Para voltar ao
   * período lido, declara-se esse período. O índice único official_imports_sha_aplicado (SHA-256 e período declarado,
   * "sem período" como valor próprio) segura a corrida.
   */
  private jaAplicada(db: Db, sha256: string, declarado: { de: string; ate: string } | null) {
    return db.officialImport.findFirst({
      where: {
        sha256,
        status: 'APLICADA',
        ...(declarado ? { declaredPeriod: true, periodFrom: new Date(`${declarado.de}T00:00:00Z`), periodTo: new Date(`${declarado.ate}T00:00:00Z`) } : {}),
      },
      orderBy: { appliedAt: 'desc' },
      select: { id: true, appliedAt: true },
    });
  }

  /**
   * POST /vigilancia/importacoes (corpo cru, lido por `lerCorpo`). Antes de ler o corpo (o Node descarta o corpo não
   * lido): 409 IMPORTACAO_OCUPADA com outra importação do tenant lendo ou aplicando; 409 IMPORTACAO_SERVIDOR_OCUPADO com
   * a vez com a leitura ou a aplicação de outro tenant, com o processo no teto de arquivos na memória ou com outro envio
   * do tenant chegando. Depois do corpo, a vez é tomada: se outro tenant a tomou enquanto o arquivo chegava, o 409 vem
   * aí. O mesmo arquivo já aplicado (sem período declarado, ou com o mesmo período declarado): `{ jaImportado }`, sem
   * criar nada. Senão, cria a linha PROCESSANDO e lê o arquivo em segundo plano: a prévia pronta dentro da espera volta
   * como sempre (201); a falha dentro da espera apaga a linha e volta como sempre (nada fica gravado); senão, 202 com o
   * que já se sabe.
   */
  async enviar(ctx: RequestContext, lerCorpo: () => Promise<Buffer>, consulta: ConsultaEnvioImportacao): Promise<RespostaEnvioImportacao> {
    if (!!consulta.de !== !!consulta.ate) throw new DomainError('PERIODO_INVALIDO', 'Informe o início e o fim do período, ou nenhum dos dois', HttpStatus.BAD_REQUEST);
    for (const [rotulo, valor] of [
      ['início', consulta.de],
      ['fim', consulta.ate],
    ] as const)
      if (valor !== undefined && !dataExiste(valor)) throw new DomainError('PERIODO_INVALIDO', `O ${rotulo} do período não é uma data válida (${valor}). Use AAAA-MM-DD.`, HttpStatus.BAD_REQUEST);
    if (consulta.de && consulta.ate && consulta.de > consulta.ate) throw new DomainError('PERIODO_INVALIDO', 'O início do período vem depois do fim', HttpStatus.BAD_REQUEST);
    const p = ImportacaoService.processo;
    await this.conferirEmAndamento(ctx.db);
    // A vez com a leitura ou a aplicação de outro tenant: 409 sem ler o corpo nem reservar a carga. A carga é reservada
    // logo depois, sem espera no meio (sem corrida entre envios simultâneos), e solta quando o arquivo deixa a memória:
    // no erro ou na resposta sem trabalho; com o trabalho em segundo plano, quando ele acaba.
    this.conferirVez(p, ctx.tenant.id);
    const soltarCarga = CargasDoProcesso.atual.reservar(ctx.tenant.id);
    let comCarga = true;
    try {
      const arquivo = await lerCorpo();
      if (!arquivo.length) throw new DomainError('ARQUIVO_VAZIO', 'Arquivo vazio', HttpStatus.BAD_REQUEST);
      const ritmo = new Ritmo();
      const sha256 = await this.sha256(arquivo, ritmo);
      const declarado = consulta.de && consulta.ate ? { de: consulta.de, ate: consulta.ate } : null;
      const aplicada = await this.jaAplicada(ctx.db, sha256, declarado);
      if (aplicada) return { jaImportado: { id: aplicada.id, aplicadoEm: (aplicada.appliedAt ?? new Date()).toISOString() } };
      // A vez de novo: outro tenant pode tê-la tomado enquanto o corpo chegava.
      this.tomarVez(p, ctx.tenant.id);
      let comVez = true;
      try {
        const id = uuidv7();
        const agora = new Date();
        const nome = consulta.nome.slice(0, 255);
        await ctx.db.officialImport.create({
          data: {
            id,
            status: 'PROCESSANDO',
            fileName: nome,
            sha256,
            sizeBytes: arquivo.length,
            periodFrom: declarado ? new Date(`${declarado.de}T00:00:00Z`) : null,
            periodTo: declarado ? new Date(`${declarado.ate}T00:00:00Z`) : null,
            declaredPeriod: !!declarado,
            createdBy: ctx.session.userId,
            createdAt: agora,
            workingStep: 'LENDO',
            workingSince: agora,
            workingAt: agora,
          },
          select: { id: true },
        });
        comVez = false;
        comCarga = false;
        const desfecho = await this.emSegundoPlano(
          p,
          ctx.db,
          ctx.tenant.id,
          id,
          'LENDO',
          () => this.criarPrevia(ctx, id, arquivo, consulta, sha256, ritmo),
          {
            // Dentro da espera, como antes: nada fica gravado.
            desfazer: () => ctx.db.officialImport.deleteMany({ where: { id, status: 'PROCESSANDO' } }),
            registrar: (erro) =>
              ctx.db.officialImport.updateMany({
                where: { id, status: 'PROCESSANDO' },
                data: { status: 'FALHOU', error: erro as unknown as TenantPrisma.InputJsonValue, workingStep: null, workingSince: null, workingAt: null, payload: null, preview: TenantPrisma.DbNull },
              }),
          },
          soltarCarga,
        );
        if (!desfecho) return { id, status: 'PROCESSANDO', arquivo: nome, tamanhoBytes: arquivo.length, desde: agora.toISOString() };
        if (!desfecho.ok) throw desfecho.erro;
        return this.detalhe(ctx, id, { auditar: false });
      } finally {
        if (comVez) this.devolverVez(p);
      }
    } finally {
      if (comCarga) soltarCarga();
    }
  }

  /** Lê o envio e transforma a linha PROCESSANDO em PREVIA (em segundo plano, com a vez do processo). */
  private async criarPrevia(ctx: RequestContext, id: string, arquivo: Buffer, consulta: ConsultaEnvioImportacao, sha256: string, ritmo: Ritmo): Promise<void> {
    await ImportacaoService.ganchoDeTeste?.('LENDO', id, 'INICIO');
    const { ibge } = await municipioDoTenant(this.master, ctx.tenant.id);
    const [sensiveis, grupoDoCid, porNome] = await Promise.all([gruposSigilosos(ctx.db), grupoDoCidFabrica(ctx.db), municipiosPorNome(ctx.db)]);
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    let leitura: LeituraEnvio;
    try {
      leitura = await lerEnvio(consulta.nome, new Uint8Array(arquivo.buffer, arquivo.byteOffset, arquivo.byteLength), {
        codificacao: consulta.codificacao,
        hoje,
        municipio: ibge,
        sensiveis,
        grupoDoCid,
        municipiosPorNome: porNome,
        ritmo,
      });
    } catch (e) {
      if (e instanceof ErroArquivo) throw new DomainError('ARQUIVO_RECUSADO', e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
    let pasta: string | null = null;
    let payload: EscritorPayload | null = null;
    let fechado = false;
    try {
      pasta = mkdtempSync(join(tmpdir(), 'omni-previa-'));
      payload = new EscritorPayload(join(pasta, 'payload.gz'));
      const escritor = payload;
      const validos = leitura.arquivos.filter((a) => !a.ignorado);
      if (!validos.length) throw new DomainError('SEM_REGISTROS', `Nenhum arquivo com notificações reconhecidas. ${leitura.avisos.join(' ')}`.trim(), HttpStatus.UNPROCESSABLE_ENTITY, { arquivos: leitura.arquivos });
      if (!leitura.total)
        throw new DomainError('SEM_REGISTROS', `Nenhum registro válido no envio (${leitura.recusados} recusado(s)).`, HttpStatus.UNPROCESSABLE_ENTITY, {
          arquivos: leitura.arquivos,
          motivosRecusa: leitura.motivosRecusa,
        });

      const declarado = consulta.de && consulta.ate ? { de: consulta.de, ate: consulta.ate } : null;
      const porTipo: ContagensImportacao['porTipo'] = {};
      const porSistema = new Map<SistemaOficial, number>();
      const novos: AmostraRegistro[] = [];
      const alterados: AmostraAlteracao[] = [];
      let nNovos = 0;
      let nAlterados = 0;
      let nIguais = 0;
      let foraDoPeriodo = 0;
      let nosDoisSistemas = 0;
      for await (const lote of leitura.registros(LOTE_COMPARACAO)) {
        const existentes = await this.existentes(ctx.db, lote);
        nosDoisSistemas += existentes.nosDoisSistemas;
        for (const c of this.comparar(lote, existentes.mapa)) {
          porTipo[c.r.tipo] = (porTipo[c.r.tipo] ?? 0) + 1;
          porSistema.set(c.r.sistema, (porSistema.get(c.r.sistema) ?? 0) + 1);
          if (declarado) {
            const d = c.r.partes[c.r.partes.length - 1]!.notificadoEm;
            if (d < declarado.de || d > declarado.ate) foraDoPeriodo++;
          }
          if (!c.linha) {
            nNovos++;
            if (novos.length < MAX_AMOSTRAS) novos.push(this.amostra(c));
          } else if (c.hash !== c.linha.contentHash) {
            nAlterados++;
            if (alterados.length < MAX_AMOSTRAS) {
              const sistema = c.linha.system !== c.r.sistema ? [{ campo: 'sistema', antes: c.linha.system, depois: c.r.sistema }] : [];
              alterados.push({ ...this.amostra(c), campos: [...sistema, ...diferencas(c.antes, c.depois)] });
            }
          } else {
            nIguais++;
          }
        }
        await escritor.escrever(lote);
        await ritmo.ceder();
      }
      // A cobertura de cada arquivo (a lista que vai no payload e que a aplicação usa e grava). Termina na data local do
      // primeiro envio do arquivo (o mesmo SHA-256, em qualquer situação, esta inclusive): reenviado depois para declarar
      // o período, o arquivo continua sem o que veio depois da exportação.
      const primeiro = (await ctx.db.officialImport.aggregate({ where: { sha256 }, _min: { createdAt: true } }))._min.createdAt ?? new Date();
      const { cobertura, avisos: avisosCobertura } = leitura.cobertura(declarado, ibge, localDateString(primeiro, ctx.tenant.timeZone));
      const ausentes = await this.ausentesPrevistos(ctx.db, cobertura, leitura, ritmo);
      // A aplicação do mesmo arquivo que vale hoje (com outro período): aplicar este envio a substitui. As outras APLICADA
      // (de outros arquivos) que confirmam um ausente dela são lidas só quando há substituição.
      const substitui: string[] = [];
      let outras: AplicadaComCobertura[] | null = null;
      for (const a of await ctx.db.officialImport.findMany({
        where: { sha256, status: 'APLICADA' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true, periodFrom: true, periodTo: true, declaredPeriod: true },
      })) {
        outras ??= await this.aplicadasComCobertura(ctx.db, { exceto: [], shaExceto: sha256 });
        const voltam = await this.voltamDaSubstituicao(ctx.db, a.id, cobertura, outras, leitura, ritmo);
        const quando = localDateString(a.createdAt, ctx.tenant.timeZone);
        const periodo = a.periodFrom && a.periodTo ? `período ${dataBr(dia(a.periodFrom)!)} a ${dataBr(dia(a.periodTo)!)}${a.declaredPeriod ? ', declarado' : ', lido das notificações'}` : 'sem período';
        substitui.push(
          `Este envio substitui a importação de ${dataBr(quando)} do mesmo arquivo (${periodo}). A cobertura passa a ser a deste envio` +
            (voltam ? `, e ${voltam.toLocaleString('pt-BR')} registro(s) que ela deu como ausentes voltam.` : '.'),
        );
      }
      const tamanhoPayload = await escritor.fechar(cobertura);
      fechado = true;

      const contagens: ContagensImportacao = {
        lidos: leitura.lidos,
        novos: nNovos,
        alterados: nAlterados,
        iguais: nIguais,
        recusados: leitura.recusados,
        duplicadosNoArquivo: leitura.duplicadosNoArquivo,
        ausentesPrevistos: ausentes.total,
        motivosRecusa: leitura.motivosRecusa,
        porTipo,
      };
      const previa: PreviaImportacao = { novos, alterados, recusados: leitura.recusas, duplicados: leitura.duplicados, ausentes: ausentes.amostra };

      // Sistema predominante, período e avisos do envio.
      const sistema = [...porSistema].sort((a, b) => b[1] - a[1])[0]![0];
      const datas = validos.flatMap((a) => (a.periodo ? [a.periodo.de, a.periodo.ate] : [])).sort();
      const periodo = declarado ?? (datas.length ? { de: datas[0]!, ate: datas[datas.length - 1]! } : null);
      const avisos = [...substitui, ...leitura.avisos, ...avisosCobertura];
      if (foraDoPeriodo) avisos.push(`${foraDoPeriodo} registro(s) com data da notificação fora do período declarado: entram, mas o período declarado é que define os ausentes.`);
      if (nosDoisSistemas) avisos.push(`${nosDoisSistemas} registro(s) gravados antes nos dois sistemas do Sinan (Net e Online) com a mesma chave: vale o do sistema da dengue ou da chikungunya. Confira na conciliação.`);
      if (validos.some((a) => a.tipo === 'ESUS_NOTIFICA_CSV'))
        avisos.push('e-SUS Notifica: exporte com o perfil de gestor municipal (o autocadastro só traz as notificações do próprio CNES) e um arquivo por ano de notificação.');
      if (validos.some((a) => a.sistema === 'SINAN_ONLINE')) avisos.push('Sinan Online: a mesma solicitação em menos de 24 horas devolve o mesmo arquivo, e o período não cruza o ano.');

      const agora = new Date();
      await ctx.db.$transaction(
        async (tx) => {
          // A prévia anterior do mesmo arquivo (troca de codificação, reenvio) é descartada; a que está sendo aplicada
          // agora (marca com sinal de vida), não. A marca de uma aplicação interrompida sai junto.
          await tx.officialImport.updateMany({
            where: { sha256, status: 'PREVIA', OR: [{ workingStep: null }, { workingAt: { lt: new Date(agora.getTime() - ImportacaoService.sinalParadoMs) } }] },
            data: {
              status: 'DESCARTADA',
              payload: null,
              preview: TenantPrisma.DbNull,
              discardedBy: ctx.session.userId,
              discardedAt: agora,
              workingStep: null,
              workingSince: null,
              workingAt: null,
            },
          });
          const { count } = await tx.officialImport.updateMany({
            where: { id, status: 'PROCESSANDO' },
            data: {
              status: 'PREVIA',
              system: sistema,
              files: leitura.arquivos as unknown as TenantPrisma.InputJsonValue,
              periodFrom: periodo ? new Date(`${periodo.de}T00:00:00Z`) : null,
              periodTo: periodo ? new Date(`${periodo.ate}T00:00:00Z`) : null,
              declaredPeriod: !!declarado,
              identified: validos.some((a) => a.identificado),
              counts: contagens as unknown as TenantPrisma.InputJsonValue,
              preview: previa as unknown as TenantPrisma.InputJsonValue,
              warnings: avisos,
              workingStep: null,
              workingSince: null,
              workingAt: null,
              error: TenantPrisma.DbNull,
            },
          });
          if (count !== 1) throw conflict('A leitura do arquivo foi interrompida: envie o arquivo de novo.');
          await this.gravarPayload(tx, id, escritor.caminho, tamanhoPayload);
          await this.audit.record(ctx, tx, {
            action: 'vigilancia.importacao_previa',
            entityType: 'OfficialImport',
            entityId: id,
            payload: {
              arquivo: consulta.nome,
              sha256,
              tamanho: arquivo.length,
              sistema,
              arquivos: leitura.arquivos.map((a) => ({ nome: a.nome, tipo: a.tipo, registros: a.registros, identificado: a.identificado })),
              contagens: { ...contagens, motivosRecusa: undefined },
            },
          });
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
    } finally {
      if (payload && !fechado) payload.abortar();
      leitura.fechar();
      if (pasta) rmSync(pasta, { recursive: true, force: true });
    }
  }

  /** Registros novos num INSERT só (SQL com um parâmetro JSON: o Prisma não guarda os dados no histórico do debug). */
  private async inserir(tx: Db, novos: Comparado[], sensiveis: ReadonlySet<string>, importacao: string, agora: Date) {
    const linhas = novos.map((c) => ({ id: uuidv7(), type: c.r.tipo, natural_key: c.r.chave, ...colunasSql(c, sensiveis) }));
    const quando = agora.toISOString();
    await tx.$executeRaw`
      INSERT INTO official_records (id, system, type, natural_key, number, notified_on, epi_week_notified, municipality_ibge, unit_cnes, agravo,
        suspected_type, group_key, symptoms_onset, epi_week_onset, residence_ibge, neighborhood_code, neighborhood_name, final_class, criterion,
        evolution, closed_on, death_on, situation, severity, excluded, sensitive, patient_name, patient_name_norm, birth_date, sex,
        mother_name_norm, cns, cpf, data, content_hash, first_import_id, last_import_id, last_seen_at, created_at, updated_at)
      SELECT r.id::uuid, r.system::"OfficialSystem", r.type::"OfficialRecordType", r.natural_key, r.number, r.notified_on::date, r.epi_week_notified,
        r.municipality_ibge, r.unit_cnes, r.agravo, r.suspected_type, r.group_key, r.symptoms_onset::date, r.epi_week_onset, r.residence_ibge,
        r.neighborhood_code, r.neighborhood_name, r.final_class, r.criterion, r.evolution, r.closed_on::date, r.death_on::date, r.situation,
        r.severity, r.excluded, r.sensitive, r.patient_name, r.patient_name_norm, r.birth_date::date, r.sex, r.mother_name_norm, r.cns, r.cpf,
        r.data, r.content_hash, ${importacao}::uuid, ${importacao}::uuid, ${quando}::timestamptz AT TIME ZONE 'UTC',
        ${quando}::timestamptz AT TIME ZONE 'UTC', ${quando}::timestamptz AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) AS r(id text, system text, type text, natural_key text, number text, notified_on text,
        epi_week_notified text, municipality_ibge text, unit_cnes text, agravo text, suspected_type text, group_key text, symptoms_onset text,
        epi_week_onset text, residence_ibge text, neighborhood_code text, neighborhood_name text, final_class text, criterion text, evolution text,
        closed_on text, death_on text, situation text, severity text, excluded boolean, sensitive boolean, patient_name text, patient_name_norm text,
        birth_date text, sex text, mother_name_norm text, cns text, cpf text, data jsonb, content_hash text)`;
  }

  /**
   * Registros alterados num UPDATE só (SQL com um parâmetro JSON, como o INSERT; antes era um UPDATE por registro dentro
   * da transação): as colunas do estado, o sistema (o mesmo registro gravado no outro sistema do Sinan muda de sistema;
   * a chave natural é a mesma), o hash, a última importação, a volta dos ausentes e o updated_at, com o instante da
   * aplicação (o mesmo de last_seen_at).
   */
  private async atualizar(tx: Db, alterados: Comparado[], sensiveis: ReadonlySet<string>, importacao: string, agora: Date) {
    const linhas = alterados.map((c) => ({ id: c.linha!.id, ...colunasSql(c, sensiveis) }));
    const quando = agora.toISOString();
    await tx.$executeRaw`
      UPDATE official_records r SET system = x.system::"OfficialSystem", number = x.number, notified_on = x.notified_on::date,
        epi_week_notified = x.epi_week_notified, municipality_ibge = x.municipality_ibge, unit_cnes = x.unit_cnes, agravo = x.agravo,
        suspected_type = x.suspected_type, group_key = x.group_key, symptoms_onset = x.symptoms_onset::date, epi_week_onset = x.epi_week_onset,
        residence_ibge = x.residence_ibge, neighborhood_code = x.neighborhood_code, neighborhood_name = x.neighborhood_name,
        final_class = x.final_class, criterion = x.criterion, evolution = x.evolution, closed_on = x.closed_on::date, death_on = x.death_on::date,
        situation = x.situation, severity = x.severity, excluded = x.excluded, sensitive = x.sensitive, patient_name = x.patient_name,
        patient_name_norm = x.patient_name_norm, birth_date = x.birth_date::date, sex = x.sex, mother_name_norm = x.mother_name_norm,
        cns = x.cns, cpf = x.cpf, data = x.data, content_hash = x.content_hash, last_import_id = ${importacao}::uuid,
        last_seen_at = ${quando}::timestamptz AT TIME ZONE 'UTC', absent_since = NULL, absent_import_id = NULL,
        updated_at = ${quando}::timestamptz AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) AS x(id text, system text, number text, notified_on text, epi_week_notified text,
        municipality_ibge text, unit_cnes text, agravo text, suspected_type text, group_key text, symptoms_onset text, epi_week_onset text,
        residence_ibge text, neighborhood_code text, neighborhood_name text, final_class text, criterion text, evolution text, closed_on text,
        death_on text, situation text, severity text, excluded boolean, sensitive boolean, patient_name text, patient_name_norm text,
        birth_date text, sex text, mother_name_norm text, cns text, cpf text, data jsonb, content_hash text)
      WHERE r.id = x.id::uuid`;
  }

  /**
   * Registros iguais cuja origem dos campos mudou (o NINDINET depois do NINDINET com o DBF do agravo, e o contrário):
   * só `data` (com `_fontes`), a última importação, a volta dos ausentes e o updated_at, num UPDATE só.
   */
  private async atualizarFontes(tx: Db, iguais: Comparado[], sensiveis: ReadonlySet<string>, importacao: string, agora: Date) {
    const linhas = iguais.map((c) => ({ id: c.linha!.id, data: colunasDoEstado(c.r.sistema, c.depois, sensiveis).data }));
    const quando = agora.toISOString();
    await tx.$executeRaw`
      UPDATE official_records r SET data = x.data, last_import_id = ${importacao}::uuid, last_seen_at = ${quando}::timestamptz AT TIME ZONE 'UTC',
        absent_since = NULL, absent_import_id = NULL, updated_at = ${quando}::timestamptz AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) AS x(id text, data jsonb)
      WHERE r.id = x.id::uuid`;
  }

  /** Payload do arquivo temporário para o banco, em fatias (nenhuma cópia inteira dele na memória). */
  private async gravarPayload(tx: Db, id: string, caminho: string, tamanho: number) {
    const fd = openSync(caminho, 'r');
    try {
      const passo = ImportacaoService.fatiaPayload;
      for (let pos = 0; pos < tamanho; pos += passo) {
        const fatia = Buffer.allocUnsafe(Math.min(passo, tamanho - pos));
        for (let lidos = 0; lidos < fatia.length; ) {
          const n = readSync(fd, fatia, lidos, fatia.length - lidos, pos + lidos);
          if (!n) throw new Error('Payload da prévia cortado no disco');
          lidos += n;
        }
        await tx.$executeRaw`UPDATE official_imports SET payload = COALESCE(payload, ''::bytea) || ${fatia} WHERE id = ${id}::uuid`;
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Payload do banco em fatias (para o gunzip em fluxo da aplicação). */
  private async *fatiasDoPayload(db: Db, id: string): AsyncGenerator<Uint8Array> {
    const [linha] = await db.$queryRaw<{ n: number | null }[]>`SELECT octet_length(payload)::int AS n FROM official_imports WHERE id = ${id}::uuid`;
    const tamanho = linha?.n ?? 0;
    const passo = ImportacaoService.fatiaPayload;
    for (let pos = 1; pos <= tamanho; pos += passo) {
      const [f] = await db.$queryRaw<{ parte: Uint8Array }[]>`SELECT substring(payload FROM ${pos}::int FOR ${passo}::int) AS parte FROM official_imports WHERE id = ${id}::uuid`;
      if (!f?.parte) throw new Error('Payload da prévia sumiu durante a aplicação');
      yield f.parte;
    }
  }

  // ───────────────────────────── consultas ─────────────────────────────

  private async nomes(ctx: RequestContext, ids: (string | null)[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unicos.length) return new Map();
    const users = await ctx.db.user.findMany({ where: { id: { in: unicos } }, select: { id: true, name: true, socialName: true } });
    return new Map(users.map((u) => [u.id, u.socialName ?? u.name]));
  }

  private resumo(
    imp: {
      id: string;
      system: SistemaOficial | null;
      status: StatusImportacao;
      fileName: string;
      sizeBytes: number;
      periodFrom: Date | null;
      periodTo: Date | null;
      declaredPeriod: boolean;
      identified: boolean;
      counts: unknown;
      createdAt: Date;
      createdBy: string;
      appliedAt: Date | null;
      appliedBy: string | null;
      discardedAt: Date | null;
      discardedBy: string | null;
      workingStep: string | null;
      workingSince: Date | null;
      workingAt: Date | null;
      error: unknown;
      applyResult: unknown;
      supersededBy: string | null;
    },
    nomes: Map<string, string>,
    substitutas: Map<string, ImportacaoDoMesmoArquivo>,
  ): ResumoImportacao {
    const contagens = imp.counts as Partial<ContagensImportacao> | null;
    const erro = imp.error as ErroImportacao | null;
    return {
      id: imp.id,
      sistema: imp.system,
      status: imp.status,
      arquivo: imp.fileName,
      tamanhoBytes: imp.sizeBytes,
      periodo: imp.periodFrom && imp.periodTo ? { de: dia(imp.periodFrom)!, ate: dia(imp.periodTo)! } : null,
      periodoDeclarado: imp.declaredPeriod,
      identificado: imp.identified,
      // A linha nasce com '{}' (PROCESSANDO) e assim fica se a leitura falha.
      contagens: typeof contagens?.lidos === 'number' ? (contagens as ContagensImportacao) : null,
      criadoEm: imp.createdAt.toISOString(),
      criadoPor: nomes.get(imp.createdBy) ?? null,
      aplicadoEm: imp.appliedAt?.toISOString() ?? null,
      aplicadoPor: imp.appliedBy ? (nomes.get(imp.appliedBy) ?? null) : null,
      descartadoEm: imp.discardedAt?.toISOString() ?? null,
      descartadoPor: imp.discardedBy ? (nomes.get(imp.discardedBy) ?? null) : null,
      expirada: imp.status === 'DESCARTADA' && !imp.discardedBy,
      processamento: imp.workingStep && imp.workingSince && imp.workingAt ? { etapa: imp.workingStep as EtapaImportacao, desde: imp.workingSince.toISOString(), atualizadoEm: imp.workingAt.toISOString() } : null,
      erro: erro ? { codigo: erro.codigo, mensagem: erro.mensagem } : null,
      resultadoAplicacao: resultadoSemCobertura(imp.applyResult),
      substituidaPor: imp.supersededBy ? (substitutas.get(imp.supersededBy) ?? null) : null,
    };
  }

  /** As aplicações que substituíram as importações (`superseded_by`), pelo id. */
  private async substitutas(db: Db, ids: (string | null)[]): Promise<Map<string, ImportacaoDoMesmoArquivo>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unicos.length) return new Map();
    const rows = await db.officialImport.findMany({
      where: { id: { in: unicos } },
      select: { id: true, createdAt: true, appliedAt: true, periodFrom: true, periodTo: true, declaredPeriod: true },
    });
    return new Map(rows.map((r) => [r.id, this.doMesmoArquivo(r)]));
  }

  private doMesmoArquivo(r: { id: string; createdAt: Date; appliedAt: Date | null; periodFrom: Date | null; periodTo: Date | null; declaredPeriod: boolean }): ImportacaoDoMesmoArquivo {
    return {
      id: r.id,
      enviadaEm: r.createdAt.toISOString(),
      aplicadaEm: r.appliedAt?.toISOString() ?? null,
      periodo: r.periodFrom && r.periodTo ? { de: dia(r.periodFrom)!, ate: dia(r.periodTo)! } : null,
      periodoDeclarado: r.declaredPeriod,
    };
  }

  private readonly selectResumo = {
    id: true,
    system: true,
    status: true,
    fileName: true,
    sizeBytes: true,
    periodFrom: true,
    periodTo: true,
    declaredPeriod: true,
    identified: true,
    counts: true,
    createdAt: true,
    createdBy: true,
    appliedAt: true,
    appliedBy: true,
    discardedAt: true,
    discardedBy: true,
    workingStep: true,
    workingSince: true,
    workingAt: true,
    error: true,
    applyResult: true,
    supersededBy: true,
  } as const;

  /** GET /vigilancia/importacoes. */
  async listar(ctx: RequestContext): Promise<ListaImportacoes> {
    await this.recuperarInterrompidos(ctx.db);
    const rows = await ctx.db.officialImport.findMany({ orderBy: { createdAt: 'desc' }, take: 200, select: this.selectResumo });
    const nomes = await this.nomes(
      ctx,
      rows.flatMap((r) => [r.createdBy, r.appliedBy, r.discardedBy]),
    );
    const substitutas = await this.substitutas(
      ctx.db,
      rows.map((r) => r.supersededBy),
    );
    return rows.map((r) => this.resumo(r, nomes, substitutas));
  }

  /**
   * GET /vigilancia/importacoes/:id. Sem `notificacao.sensivel`, o nome do registro sigiloso não aparece na prévia. A
   * prévia (lista nominal, auditada a cada leitura) não vem no modo de acompanhamento (`?acompanhar=1`, a tela acompanha
   * a leitura e a aplicação em segundo plano por ele) nem enquanto a importação é aplicada (a linha continua PREVIA até
   * o fim da transação): nesses casos, nada vai para a auditoria.
   */
  async detalhe(ctx: RequestContext, id: string, opts: { auditar?: boolean; acompanhar?: boolean } = {}): Promise<DetalheImportacao> {
    await this.recuperarInterrompidos(ctx.db, id);
    const imp = await ctx.db.officialImport.findUnique({ where: { id }, select: { ...this.selectResumo, sha256: true, files: true, warnings: true } });
    if (!imp) throw notFound('Importação');
    const comPrevia = !opts.acompanhar && imp.status === 'PREVIA' && imp.workingStep !== 'APLICANDO';
    const lida = comPrevia ? await ctx.db.officialImport.findUnique({ where: { id }, select: { preview: true, workingStep: true } }) : null;
    const nomes = await this.nomes(ctx, [imp.createdBy, imp.appliedBy, imp.discardedBy]);
    const sensivel = roleHasPermission(ctx.session.role, 'notificacao.sensivel');
    // A aplicação pode ter começado entre as duas leituras: a prévia só vale se a linha continuar sem a marca.
    const bruta = lida && lida.workingStep !== 'APLICANDO' ? (lida.preview as PreviaImportacao | null) : null;
    const mascarar = <T extends AmostraRegistro>(a: T): T => (a.sigiloso && !sensivel ? { ...a, paciente: null } : a);
    const previa: PreviaImportacao | null = bruta
      ? {
          novos: bruta.novos.map(mascarar),
          alterados: bruta.alterados.map((a): AmostraAlteracao => {
            const m = mascarar(a);
            return a.sigiloso && !sensivel ? { ...m, campos: m.campos.filter((c) => !(CAMPOS_IDENTIFICACAO as readonly string[]).includes(c.campo)) } : m;
          }),
          recusados: bruta.recusados,
          duplicados: bruta.duplicados,
          ausentes: bruta.ausentes.map(mascarar),
        }
      : null;
    // A prévia é uma lista nominal: quem a abre fica na trilha (como na exportação CSV).
    const nominais = previa ? [...previa.novos, ...previa.alterados, ...previa.ausentes].filter((a) => a.paciente) : [];
    if (opts.auditar !== false && nominais.length)
      await this.audit.recordStandalone(ctx, {
        action: 'vigilancia.importacao_ver_previa',
        entityType: 'OfficialImport',
        entityId: id,
        payload: { nominais: nominais.length, sigilosos: nominais.filter((a) => a.sigiloso).length },
      });
    const horas = ctx.tenant.settings.vigilancia.consolidacao.expiraPreviaHoras;
    const resumo = this.resumo(imp, nomes, await this.substitutas(ctx.db, [imp.supersededBy]));
    const erro = imp.error as ErroImportacao | null;
    return {
      ...resumo,
      // No detalhe, o erro vem com os detalhes da resposta de erro (SEM_REGISTROS: arquivos detectados e motivos).
      erro: resumo.erro && erro?.detalhes !== undefined ? { ...resumo.erro, detalhes: erro.detalhes } : resumo.erro,
      sha256: imp.sha256,
      arquivos: imp.files as unknown as ArquivoDetectado[],
      previa,
      avisos: (imp.warnings ?? []) as string[],
      expiraEm: imp.status === 'PREVIA' ? new Date(imp.createdAt.getTime() + horas * HORA).toISOString() : null,
    };
  }

  // ───────────────────────────── aplicação ─────────────────────────────

  /**
   * POST /vigilancia/importacoes/:id/aplicar. Confere a prévia, reivindica a aplicação (marca APLICANDO, atômica) e
   * aplica em segundo plano: o que termina dentro da espera volta como sempre (200 com o resultado, ou o erro de sempre,
   * sem nada gravado); senão, 202 e a tela acompanha pelo detalhe.
   */
  async aplicar(ctx: RequestContext, id: string): Promise<RespostaAplicacao> {
    await this.recuperarInterrompidos(ctx.db, id);
    const imp = await ctx.db.officialImport.findUnique({
      where: { id },
      select: { id: true, status: true, sha256: true, counts: true, createdAt: true, discardedBy: true, fileName: true, workingStep: true, declaredPeriod: true, periodFrom: true, periodTo: true },
    });
    if (!imp) throw notFound('Importação');
    if (imp.status === 'PROCESSANDO') throw conflict('A prévia ainda está sendo preparada: aguarde a leitura do arquivo terminar.');
    if (imp.status === 'FALHOU') throw conflict('A leitura do arquivo falhou e não gerou prévia: envie o arquivo de novo.');
    if (imp.status === 'APLICADA') throw conflict('A importação já foi aplicada');
    if (imp.status === 'SUBSTITUIDA') throw conflict(MSG_SUBSTITUIDA);
    if (imp.workingStep === 'APLICANDO') throw conflict('A importação já está sendo aplicada: acompanhe nesta tela.');
    if (imp.status === 'DESCARTADA') throw conflict(imp.discardedBy ? 'A prévia foi descartada' : 'A prévia expirou: envie o arquivo de novo');
    const horas = ctx.tenant.settings.vigilancia.consolidacao.expiraPreviaHoras;
    if (imp.createdAt.getTime() + horas * HORA < Date.now()) {
      await this.expirarPrevias(ctx.db, new Date(), horas);
      throw conflict('A prévia expirou: envie o arquivo de novo');
    }
    const [tem] = await ctx.db.$queryRaw<{ n: number | null }[]>`SELECT octet_length(payload)::int AS n FROM official_imports WHERE id = ${id}::uuid`;
    if (!tem?.n) throw conflict('A prévia não tem mais os registros: envie o arquivo de novo');
    const p = ImportacaoService.processo;
    this.tomarVez(p, ctx.tenant.id);
    let comVez = true;
    try {
      // Reivindicação atômica: só a PREVIA sem marca, ou com a marca de uma aplicação interrompida (sinal parado).
      const agora = new Date();
      const { count } = await ctx.db.officialImport.updateMany({
        where: { id, status: 'PREVIA', OR: [{ workingStep: null }, { workingAt: { lt: new Date(agora.getTime() - ImportacaoService.sinalParadoMs) } }] },
        data: { workingStep: 'APLICANDO', workingSince: agora, workingAt: agora, error: TenantPrisma.DbNull },
      });
      if (count !== 1) throw conflict('A importação já está sendo aplicada (ou mudou): abra de novo.');
      comVez = false;
      const desfecho = await this.emSegundoPlano(p, ctx.db, ctx.tenant.id, id, 'APLICANDO', () => this.aplicarPrevia(ctx, imp), {
        // Dentro da espera, a falha volta ao pedido: a linha continua PREVIA, sem erro gravado.
        desfazer: () => this.limparMarcaDaAplicacao(ctx.db, id, null),
        registrar: (erro) => this.limparMarcaDaAplicacao(ctx.db, id, erro),
      });
      if (!desfecho) return { id, status: 'APLICANDO' };
      if (!desfecho.ok) throw desfecho.erro;
      return desfecho.valor;
    } finally {
      if (comVez) this.devolverVez(p);
    }
  }

  private async aplicarPrevia(
    ctx: RequestContext,
    imp: { id: string; sha256: string; counts: unknown; fileName: string; declaredPeriod: boolean; periodFrom: Date | null; periodTo: Date | null },
  ): Promise<ResultadoAplicacao> {
    const id = imp.id;
    const sensiveis = await gruposSigilosos(ctx.db);
    const agora = new Date();
    const avisos: string[] = [];
    const ritmo = new Ritmo();

    const resultado = await ctx.db
      .$transaction(
        async (tx) => {
          // Uma aplicação por vez (a mesma chave pode vir em dois envios ao mesmo tempo). Logo depois, e antes de qualquer
          // escrita em official_records, a trava da conciliação: as ações da conciliação (a tarefa e as manuais) não
          // mexem nos registros no meio da aplicação. A ordem é sempre a mesma (importação, depois conciliação), e a
          // trava é reentrante na mesma sessão (a conciliação automática, dentro desta transação, pega de novo).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilancia:importacao'))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilancia:conciliacao'))`;
          const atual = await tx.officialImport.findUnique({ where: { id }, select: { status: true } });
          if (atual?.status !== 'PREVIA') throw conflict('A importação mudou: abra de novo');
          // O mesmo arquivo com o mesmo período declarado (ou, sem período declarado, com qualquer um) já aplicado.
          const declarado = imp.declaredPeriod && imp.periodFrom && imp.periodTo ? { de: dia(imp.periodFrom)!, ate: dia(imp.periodTo)! } : null;
          if (await this.jaAplicada(tx, imp.sha256, declarado)) throw conflict('Este arquivo já foi aplicado');
          // As aplicações do mesmo arquivo com outro período: esta as substitui (vale a mais recente). Os ausentes que
          // cada uma marcou são contados antes de gravar (o resultado diz quantos voltaram).
          const aplicadasAntes: AnteriorDoArquivo[] = [];
          for (const a of await tx.officialImport.findMany({
            where: { sha256: imp.sha256, status: 'APLICADA', id: { not: id } },
            orderBy: { createdAt: 'asc' },
            select: { id: true, createdAt: true, appliedAt: true, periodFrom: true, periodTo: true, declaredPeriod: true },
          }))
            aplicadasAntes.push({ ...a, ausentes: await tx.officialRecord.count({ where: { absentImportId: a.id } }) });
          await ImportacaoService.ganchoDeTeste?.('APLICANDO', id, 'INICIO');

          let novos = 0;
          let alterados = 0;
          let iguais = 0;
          let voltaram = 0;
          const leitor = new LeitorPayload(this.fatiasDoPayload(tx, id), ritmo);
          for await (const lote of leitor.lotes(LOTE_COMPARACAO)) {
            const comparados = this.comparar(lote, (await this.existentes(tx, lote)).mapa);
            const vinculadosAlterados: string[] = [];
            const criar: Comparado[] = [];
            const mudar: Comparado[] = [];
            const fontes: Comparado[] = [];
            const tocar: string[] = [];
            for (const c of comparados) {
              if (!c.linha) {
                criar.push(c);
                continue;
              }
              if (c.linha.absentSince) voltaram++;
              if (c.hash !== c.linha.contentHash) {
                alterados++;
                if (c.linha.notificationId) vinculadosAlterados.push(c.linha.id);
                mudar.push(c);
              } else {
                iguais++;
                if (!mesmasFontes(c.antes.fontes, c.depois.fontes)) fontes.push(c);
                else tocar.push(c.linha.id);
              }
            }
            for (let i = 0; i < mudar.length; i += LOTE) await this.atualizar(tx, mudar.slice(i, i + LOTE), sensiveis, id, agora);
            for (let i = 0; i < fontes.length; i += LOTE) await this.atualizarFontes(tx, fontes.slice(i, i + LOTE), sensiveis, id, agora);
            if (tocar.length) await tx.officialRecord.updateMany({ where: { id: { in: tocar } }, data: { lastImportId: id, lastSeenAt: agora, absentSince: null, absentImportId: null } });
            for (let i = 0; i < criar.length; i += LOTE) {
              const parte = criar.slice(i, i + LOTE);
              await this.inserir(tx, parte, sensiveis, id, agora);
              novos += parte.length;
            }
            // Divergências dos pares que já estavam vinculados e mudaram.
            if (vinculadosAlterados.length) await this.conciliacao.atualizarDivergencias(tx, vinculadosAlterados);
            await ritmo.ceder();
          }
          await ImportacaoService.ganchoDeTeste?.('APLICANDO', id, 'GRAVADO');
          const cobertura = leitor.cobertura!;

          // O mesmo arquivo aplicado antes com outro período: esta aplicação o substitui, e os ausentes que ele marcou
          // fora da cobertura desta voltam, menos os que outra importação APLICADA confirma.
          const { substituidas, unidades: unidadesQueVoltaram, semanas: semanasQueVoltaram } = await this.substituirAnteriores(tx, aplicadasAntes, cobertura, id, agora);

          // Ausentes: só dentro da cobertura de cada arquivo do envio (sistema, tipo, agravos, período, municípios, ficha e
          // CNES), entre os registros que este envio não tocou. Nunca apaga.
          const ausentesMarcados = await this.marcarAusentes(tx, cobertura, id, agora);

          // Unidades pelo CNES.
          const ligadas = await tx.$executeRaw`
            UPDATE official_records r SET unit_id = u.id FROM units u
            WHERE r.last_import_id = ${id}::uuid AND u.cnes = r.unit_cnes AND r.unit_id IS DISTINCT FROM u.id`;
          await tx.$executeRaw`
            UPDATE official_records r SET unit_id = NULL
            WHERE r.last_import_id = ${id}::uuid AND r.unit_id IS NOT NULL
              AND (r.unit_cnes IS NULL OR NOT EXISTS (SELECT 1 FROM units u WHERE u.cnes = r.unit_cnes))`;

          // Conciliação automática (degraus 1 e 2) dos registros tocados, em páginas (a regra do "único dos dois lados"
          // consulta todos os concorrentes no banco, não só os da página).
          let vinculados = 0;
          for (let depois: string | null = null; ; ) {
            const pagina: { id: string }[] = await tx.officialRecord.findMany({
              where: { lastImportId: id, ...(depois ? { id: { gt: depois } } : {}) },
              orderBy: { id: 'asc' },
              take: PAGINA,
              select: { id: true },
            });
            if (pagina.length) vinculados += await this.conciliacao.conciliarAutomatico(tx, { recordIds: pagina.map((p) => p.id), timeZone: ctx.tenant.timeZone });
            if (pagina.length < PAGINA) break;
            depois = pagina[pagina.length - 1]!.id;
          }

          const anteriores = imp.counts as unknown as ContagensImportacao;
          const contagens: ContagensImportacao = { ...anteriores, novos, alterados, iguais, ausentesPrevistos: ausentesMarcados };
          // As unidades e semanas tocadas (os registros do arquivo e os que voltaram com a substituição): a negativa delas
          // é reconciliada depois da transação.
          const unidades = [
            ...new Set([
              ...(await tx.$queryRaw<{ u: string }[]>`SELECT DISTINCT unit_id::text AS u FROM official_records WHERE last_import_id = ${id}::uuid AND unit_id IS NOT NULL`).map((r) => r.u),
              ...unidadesQueVoltaram,
            ]),
          ];
          const semanas = [
            ...new Set([
              ...(await tx.$queryRaw<{ s: string }[]>`SELECT DISTINCT trim(epi_week_notified) AS s FROM official_records WHERE last_import_id = ${id}::uuid AND trim(COALESCE(epi_week_notified, '')) <> ''`).map(
                (r) => r.s,
              ),
              ...semanasQueVoltaram,
            ]),
          ];
          // O resultado fica gravado com a aplicação, junto com a cobertura dos ausentes que ela usou (a lista por
          // arquivo, já com o fim no primeiro envio): a substituição de outra aplicação a consulta para saber se um
          // ausente continua confirmado, e a base consolidada e a conciliação leem dela o que cada arquivo cobre
          // (cobertura-importacao.ts). A cobertura não vai para as respostas da API. A reconciliação da negativa roda
          // depois da transação: até ela terminar, fica o aviso de que não rodou (verdade se o processo cair antes; o job
          // reconcilia depois).
          const gravado: ResultadoAplicacao = {
            id,
            aplicadoEm: agora.toISOString(),
            contagens,
            ausentesMarcados,
            voltaram,
            unidadesLigadas: ligadas,
            vinculadosAutomaticamente: vinculados,
            negativasCanceladas: 0,
            avisos: unidades.length ? [AVISO_NEGATIVA_PENDENTE] : [],
            substituidas,
          };
          // A marca APLICANDO continua até a reconciliação da negativa acabar (a tela espera o resultado final).
          const { count } = await tx.officialImport.updateMany({
            where: { id, status: 'PREVIA', workingStep: 'APLICANDO' },
            data: {
              status: 'APLICADA',
              appliedBy: ctx.session.userId,
              appliedAt: agora,
              payload: null,
              preview: TenantPrisma.DbNull,
              counts: contagens as unknown as TenantPrisma.InputJsonValue,
              applyResult: { ...gravado, cobertura } as unknown as TenantPrisma.InputJsonValue,
              error: TenantPrisma.DbNull,
            },
          });
          if (count !== 1) throw conflict('A importação mudou: abra de novo');
          await this.audit.record(ctx, tx, {
            action: 'vigilancia.importacao_aplicada',
            entityType: 'OfficialImport',
            entityId: id,
            payload: {
              arquivo: imp.fileName,
              sha256: imp.sha256,
              contagens: { ...contagens, motivosRecusa: undefined },
              ausentesMarcados,
              voltaram,
              unidadesLigadas: ligadas,
              vinculados,
              substituidas: substituidas.map((s) => ({ id: s.id, voltaram: s.voltaram })),
            },
          });
          return { gravado, cobertura, unidades, semanas };
        },
        { timeout: 600_000, maxWait: 30_000 },
      )
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2002') throw conflict('Este arquivo (ou um registro dele) acabou de ser aplicado por outra pessoa: abra de novo');
        throw e;
      });

    // A reconciliação da negativa fica fora da transação: se falhar, a importação vale e o job tenta de novo.
    let negativasCanceladas = 0;
    if (resultado.unidades.length) {
      try {
        negativasCanceladas = await this.negativas().reconciliar(ctx.db, { unitIds: resultado.unidades, semanas: resultado.semanas });
      } catch (e) {
        this.logger.error(`Reconciliação da negativa depois da importação ${id}: ${(e as Error).message}`);
        avisos.push(AVISO_NEGATIVA_PENDENTE);
      }
    }
    const final: ResultadoAplicacao = { ...resultado.gravado, negativasCanceladas, avisos };
    // A importação já vale: se o resultado final não for gravado agora, fica o da transação (com o aviso da negativa) e
    // a marca sai pelo sinal de vida parado.
    try {
      await ctx.db.officialImport.updateMany({
        where: { id, workingStep: 'APLICANDO' },
        data: { applyResult: { ...final, cobertura: resultado.cobertura } as unknown as TenantPrisma.InputJsonValue, workingStep: null, workingSince: null, workingAt: null },
      });
    } catch (e) {
      this.logger.error(`Resultado da importação ${id} não gravado: ${(e as Error).message}`);
    }
    return final;
  }

  /** POST /vigilancia/importacoes/:id/descartar: a PREVIA (sem aplicação em andamento) ou a FALHOU (a SUBSTITUIDA, não). */
  async descartar(ctx: RequestContext, id: string): Promise<ResultadoDescarte> {
    await this.recuperarInterrompidos(ctx.db, id);
    const agora = new Date();
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.officialImport.updateMany({
        where: { id, status: { in: ['PREVIA', 'FALHOU'] }, workingStep: null },
        data: { status: 'DESCARTADA', payload: null, preview: TenantPrisma.DbNull, discardedBy: ctx.session.userId, discardedAt: agora },
      });
      if (count !== 1) {
        const imp = await tx.officialImport.findUnique({ where: { id }, select: { status: true, workingStep: true } });
        if (!imp) throw notFound('Importação');
        if (imp.status === 'APLICADA') throw conflict('A importação já foi aplicada');
        if (imp.status === 'SUBSTITUIDA') throw conflict(`${MSG_SUBSTITUIDA} Não dá para descartar.`);
        if (imp.status === 'PROCESSANDO') throw conflict('O arquivo ainda está sendo lido: espere a prévia ficar pronta para descartar.');
        if (imp.workingStep === 'APLICANDO') throw conflict('A importação está sendo aplicada: não dá para descartar agora.');
        throw conflict('A prévia já foi descartada');
      }
      await this.audit.record(ctx, tx, { action: 'vigilancia.importacao_descartada', entityType: 'OfficialImport', entityId: id, payload: {} });
    });
    return { id, status: 'DESCARTADA', descartadoEm: agora.toISOString() };
  }

  /**
   * Job 'vigilancia': a PREVIA com mais de `horas` vira DESCARTADA e perde o payload (a que está sendo aplicada, não).
   * Devolve quantas expiraram. Antes, a leitura e a aplicação interrompidas (sinal de vida parado) saem do caminho.
   * `horas` é obrigatório: o job passa `sys.tenant.settings.vigilancia.consolidacao.expiraPreviaHoras` (com um padrão
   * fixo aqui, a configuração do tenant seria ignorada sem aviso).
   */
  async expirarPrevias(db: TenantPrisma.TransactionClient, agora: Date, horas: number): Promise<number> {
    await this.recuperarInterrompidos(db);
    const { count } = await db.officialImport.updateMany({
      where: { status: 'PREVIA', workingStep: null, createdAt: { lt: new Date(agora.getTime() - horas * HORA) } },
      data: { status: 'DESCARTADA', payload: null, preview: TenantPrisma.DbNull, discardedAt: agora },
    });
    return count;
  }
}
