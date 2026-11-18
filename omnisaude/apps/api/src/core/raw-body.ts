import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from './errors';

/**
 * Lê o corpo cru (application/zip, octet-stream ou text/csv), que não passa pelos parsers JSON/texto do main.ts.
 * Usado pelo pacote da SIGTAP (faturamento) e pelas exportações oficiais da vigilância (VIG-1c), os dois com a carga do
 * processo reservada antes (`CargasDoProcesso`).
 *
 * - Com Content-Length: acima do limite, 413 antes de ler qualquer byte; senão, o Buffer é alocado uma vez no tamanho
 *   declarado e os pedaços são copiados nele (sem a lista de pedaços mais a cópia do Buffer.concat, que dobrava a
 *   memória no fim). Mais bytes que o declarado, ou menos no fim, é erro (400).
 * - Sem Content-Length (envio em pedaços): junta os pedaços, até o limite (413).
 * - Sem pedaço novo por `LeituraDoCorpo.ociosoMs` (30 s), o envio para com 408: um cliente lento ou parado não segura
 *   a memória (e as cargas da importação) até o requestTimeout do Node (5 min).
 * Nos erros com o corpo pela metade (408, 413, 400), a resposta sai com Connection: close e a conexão é fechada logo
 * depois: o resto do corpo não é lido.
 */
export class LeituraDoCorpo {
  /** Sem pedaço novo por este tempo, o envio para (os testes diminuem). */
  static ociosoMs = 30_000;
  /** Depois do erro, o prazo para a resposta sair antes de a conexão ser derrubada. */
  static fecharMs = 5_000;
}

/** O processo ocupado com envios ou importações de outros tenants (a carga e a vez da importação). */
export const MSG_SERVIDOR_OCUPADO = 'O servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.';
/** O outro envio do mesmo tenant, ainda chegando (ou com o arquivo na memória). */
export const MSG_ENVIO_DO_TENANT = 'Outro envio da sua instituição está sendo recebido agora. Tente de novo quando ele terminar.';

/**
 * Arquivos grandes de corpo cru na memória do processo (container de 1 GiB, todos os municípios): o da importação da
 * vigilância (o corpo sendo lido e, depois, a leitura em segundo plano) e o pacote da SIGTAP (o corpo e a carga das
 * tabelas). Com o Content-Length, o Buffer do corpo é alocado de uma vez: quem lê reserva a carga antes de ler, e no teto
 * o envio recebe 409 IMPORTACAO_SERVIDOR_OCUPADO sem que o corpo seja lido (o Node descarta o resto, sem juntar). O teto
 * é de `LIMITE` cargas no processo, de qualquer tenant, e `LIMITE_TENANT` por tenant (dois envios lentos do mesmo
 * município não seguram o processo inteiro). O contador é um só para os dois envios.
 */
export class CargasDoProcesso {
  static readonly LIMITE = 2;
  static readonly LIMITE_TENANT = 1;
  /** As cargas deste processo (os testes trocam, para fazer o papel de outro processo: `ImportacaoService.comoOutroProcesso`). */
  static atual = new CargasDoProcesso();
  /** Arquivos na memória, de qualquer tenant. */
  total = 0;
  /** Arquivos na memória por tenant. */
  readonly porTenant = new Map<string, number>();

  /**
   * Reserva uma carga para o tenant antes de ler o corpo; com o tenant ou o processo no teto, 409
   * IMPORTACAO_SERVIDOR_OCUPADO. Devolve a liberação (pode ser chamada mais de uma vez).
   */
  reservar(tenantId: string): () => void {
    const doTenant = this.porTenant.get(tenantId) ?? 0;
    if (doTenant >= CargasDoProcesso.LIMITE_TENANT) throw new DomainError('IMPORTACAO_SERVIDOR_OCUPADO', MSG_ENVIO_DO_TENANT, HttpStatus.CONFLICT);
    if (this.total >= CargasDoProcesso.LIMITE) throw new DomainError('IMPORTACAO_SERVIDOR_OCUPADO', MSG_SERVIDOR_OCUPADO, HttpStatus.CONFLICT);
    this.total++;
    this.porTenant.set(tenantId, doTenant + 1);
    let solta = false;
    return () => {
      if (solta) return;
      solta = true;
      this.total--;
      const n = (this.porTenant.get(tenantId) ?? 1) - 1;
      if (n > 0) this.porTenant.set(tenantId, n);
      else this.porTenant.delete(tenantId);
    };
  }
}

/** O Content-Length do pedido; null sem ele (envio em pedaços) ou fora do formato. */
function tamanhoDeclarado(req: Request): number | null {
  const v = req.headers['content-length'];
  if (typeof v !== 'string' || !/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * O corpo que não vai ser lido até o fim: a resposta (de erro) fecha a conexão, e a conexão é derrubada se a resposta
 * não sair no prazo (o cliente que não lê).
 */
function fecharDepoisDaResposta(req: Request): void {
  const res = req.res;
  if (res && !res.headersSent) res.setHeader('Connection', 'close');
  const socket = req.socket;
  if (socket) setTimeout(() => socket.destroy(), LeituraDoCorpo.fecharMs).unref();
}

/** 413 antes de ler qualquer byte quando o Content-Length passa do limite (a conexão fecha depois da resposta). */
export function conferirTamanhoDeclarado(req: Request, limit: number): void {
  const n = tamanhoDeclarado(req);
  if (n !== null && n > limit) {
    fecharDepoisDaResposta(req);
    throw new DomainError('ARQUIVO_GRANDE', 'Arquivo maior que o permitido', 413);
  }
}

const incompleto = () => new DomainError('ENVIO_INCOMPLETO', 'O envio chegou incompleto. Envie o arquivo de novo.', 400);

export async function rawBody(req: Request, limit = 60 * 1024 * 1024): Promise<Buffer> {
  conferirTamanhoDeclarado(req, limit);
  // Corpo já lido (por um parser do main.ts) ou já encerrado: nada mais vai chegar.
  if (req.readableEnded) return Buffer.alloc(0);
  if (req.destroyed) throw incompleto();
  const declarado = tamanhoDeclarado(req);
  return new Promise<Buffer>((ok, falha) => {
    const buf = declarado !== null ? Buffer.allocUnsafe(declarado) : null;
    const pedacos: Buffer[] = [];
    let recebidos = 0;
    let terminou = false;
    let ocioso: NodeJS.Timeout | undefined;

    const terminar = (erro: unknown, corpo?: Buffer) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(ocioso);
      req.off('data', aoPedaco);
      req.off('end', aoFim);
      req.off('error', aoErro);
      req.off('close', aoFechar);
      if (erro) falha(erro);
      else ok(corpo!);
    };
    /** Para de ler no meio: o que ainda chegar é descartado (o fluxo segue sem ouvinte) até a conexão fechar. */
    const parar = (erro: DomainError) => {
      fecharDepoisDaResposta(req);
      terminar(erro);
    };
    const armar = () => {
      clearTimeout(ocioso);
      ocioso = setTimeout(() => parar(new DomainError('ENVIO_PARADO', 'O envio parou de chegar. Envie o arquivo de novo.', 408)), LeituraDoCorpo.ociosoMs);
    };
    function aoPedaco(p: Buffer) {
      recebidos += p.length;
      if (recebidos > limit) return parar(new DomainError('ARQUIVO_GRANDE', 'Arquivo maior que o permitido', 413));
      if (buf) {
        if (recebidos > buf.length) return parar(new DomainError('ENVIO_INVALIDO', 'O envio trouxe mais bytes que o tamanho declarado. Envie o arquivo de novo.', 400));
        p.copy(buf, recebidos - p.length);
      } else pedacos.push(p);
      armar();
    }
    function aoFim() {
      if (buf && recebidos < buf.length) return terminar(incompleto());
      terminar(null, buf ?? Buffer.concat(pedacos, recebidos));
    }
    function aoErro() {
      // O cliente caiu no meio ('aborted', ECONNRESET): não há a quem responder.
      terminar(incompleto());
    }
    function aoFechar() {
      if (!req.complete) terminar(incompleto());
    }

    req.on('data', aoPedaco);
    req.on('end', aoFim);
    req.on('error', aoErro);
    req.on('close', aoFechar);
    armar();
  });
}
