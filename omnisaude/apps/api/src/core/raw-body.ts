import type { Request } from 'express';
import { DomainError } from './errors';

/**
 * Lê o corpo cru (application/zip, octet-stream ou text/csv), que não passa pelos parsers JSON/texto do main.ts.
 * Usado pelo pacote da SIGTAP (faturamento) e pelas exportações oficiais da vigilância (VIG-1c).
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
