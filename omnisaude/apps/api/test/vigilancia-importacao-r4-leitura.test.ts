import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { semanaDaData } from '@omnisaude/shared';
import type { Request } from 'express';
import { zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DomainError } from '../src/core/errors';
import { LeituraDoCorpo, rawBody } from '../src/core/raw-body';
import { lerEnvio, type OpcoesLeitura, type RegistroDoEnvio } from '../src/modules/vigilancia/importacao/leitura';
import { escreverDbf, type CampoEscrita } from './helpers/dbf-escrita';

/*
 * Importação (VIG-1c), quarta rodada, sem banco: o CNES de cada arquivo do e-SUS (N0; na quinta rodada, R5-1, a
 * cobertura passou a ser a de cada arquivo: o arquivo de um CNES só fica restrito a ele mesmo com o CSV do município no
 * zip, e as entradas iguais se juntam com os CNES unidos), o fim da cobertura na data do primeiro envio do arquivo
 * (aviso-periodo-lido), a SEM_PRI da linha de caso do NSURTNET (imp-planilha-surto) e a leitura do corpo cru: o prazo
 * de ociosidade, o 413 antes do corpo e o corpo incompleto (N1). Dados sintéticos.
 */

const OPCOES: OpcoesLeitura = { hoje: '2026-11-17', municipio: '3550308' };
const enc = (s: string) => new TextEncoder().encode(s);
const X = '9000011';
const Y = '9000028';
const Z = '9000036';

async function lerTudo(nome: string, bytes: Uint8Array) {
  const l = await lerEnvio(nome, bytes, OPCOES);
  try {
    const registros: RegistroDoEnvio[] = [];
    for await (const lote of l.registros(500)) registros.push(...lote);
    return { l, registros };
  } finally {
    l.fechar();
  }
}

/** CSV do e-SUS Notifica (síndrome gripal): número e CNES de cada linha. */
const csvSg = (linhas: [string, string | null][]) =>
  enc(
    `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Classificação Final'].join(';')}\r\n${linhas
      .map(([n, cnes]) => [n, '10/06/2024', '3550308', cnes ?? '', `Pessoa ${n}`, 'Sim', 'Confirmado Laboratorial'].join(';'))
      .join('\r\n')}\r\n`,
  );
/** CSV do e-SUS Notifica de outra ficha (sem as colunas da síndrome gripal): os registros ficam fora da cobertura. */
const csvOutraFicha = (linhas: [string, string][]) =>
  enc(
    `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Vacina aplicada'].join(';')}\r\n${linhas.map(([n, cnes]) => [n, '10/06/2024', '3550308', cnes, 'X'].join(';')).join('\r\n')}\r\n`,
  );

describe('N0 e R5-1: o CNES e a cobertura de cada arquivo do e-SUS', () => {
  it('zip com o CSV da unidade X e o da Y: cada arquivo com o seu CNES; as duas entradas iguais (o mesmo período) ficam numa só, com os dois CNES; o aviso fala por arquivo', async () => {
    const { l } = await lerTudo('duas-ubs.zip', zipSync({ 'ubs-x.csv': csvSg([['352400000901', X]]), 'ubs-y.csv': csvSg([['352400000902', Y]]) }));
    expect(Object.fromEntries(l.arquivos.map((a) => [a.nome, a.cnes]))).toEqual({ 'ubs-x.csv': X, 'ubs-y.csv': Y });
    // A cobertura sai da leitura, arquivo por arquivo (os registros não levam o arquivo de origem).
    const { cobertura, avisos } = l.cobertura(null, OPCOES.municipio);
    expect(cobertura).toEqual([expect.objectContaining({ sistema: 'ESUS_NOTIFICA', tipo: 'INDIVIDUAL', grupos: ['covid'], cnes: [X, Y], de: '2024-06-10', ate: '2024-06-10' })]);
    expect(avisos).toContain(`e-SUS Notifica: 2 arquivo(s) de um estabelecimento só (ubs-x.csv, CNES ${X}; ubs-y.csv, CNES ${Y}): os ausentes de cada um valem só para o estabelecimento dele.`);
  });

  it('dois arquivos do mesmo estabelecimento: um CNES só, com o aviso de sempre', async () => {
    const { l } = await lerTudo('x-duas-semanas.zip', zipSync({ 'semana-1.csv': csvSg([['352400000911', X]]), 'semana-2.csv': csvSg([['352400000912', X]]) }));
    expect(l.arquivos.map((a) => a.cnes)).toEqual([X, X]);
    const { cobertura, avisos } = l.cobertura(null, OPCOES.municipio);
    expect(cobertura.map((c) => c.cnes)).toEqual([[X]]);
    expect(avisos).toContain(`e-SUS Notifica: o envio traz um CNES só (${X}): os ausentes valem só para esse estabelecimento.`);
  });

  it('um arquivo com mais de um CNES, ou com registro sem CNES, no mesmo envio: esse arquivo cobre o município inteiro, e o arquivo de um CNES só continua restrito ao CNES dele', async () => {
    // Na quarta rodada, os dois arquivos ficavam sem CNES (o envio inteiro valia para o município): o arquivo da unidade
    // cobria as SE do município no período dele (r4vimp-3).
    for (const outro of [
      csvSg([
        ['352400000922', Y],
        ['352400000923', Z],
      ]),
      csvSg([['352400000924', null]]),
    ]) {
      const { l } = await lerTudo('misto.zip', zipSync({ 'ubs-x.csv': csvSg([['352400000921', X]]), 'municipio.csv': outro }));
      expect(Object.fromEntries(l.arquivos.map((a) => [a.nome, a.cnes]))).toEqual({ 'ubs-x.csv': X, 'municipio.csv': null });
      const { cobertura, avisos } = l.cobertura(null, OPCOES.municipio);
      // Na ordem dos nomes: o do município (sem CNES) e o da unidade (só o CNES dela).
      expect(cobertura).toHaveLength(2);
      expect(cobertura[0]).not.toHaveProperty('cnes');
      expect(cobertura[1]).toMatchObject({ cnes: [X] });
      expect(avisos).toContain(
        `e-SUS Notifica: 1 arquivo(s) de um estabelecimento só (ubs-x.csv, CNES ${X}): os ausentes de cada um valem só para o estabelecimento dele. Os outros arquivos do e-SUS Notifica valem para o município inteiro.`,
      );
    }
  });

  it('o CSV de outra ficha (fora da cobertura) não tira a restrição do CSV da síndrome gripal', async () => {
    const { l } = await lerTudo('com-esavi.zip', zipSync({ 'ubs-x.csv': csvSg([['352400000931', X]]), 'esavi.csv': csvOutraFicha([['352400000932', Y]]) }));
    expect(Object.fromEntries(l.arquivos.map((a) => [a.nome, a.cnes]))).toEqual({ 'ubs-x.csv': X, 'esavi.csv': null });
    expect(l.cobertura(null, OPCOES.municipio).cobertura).toEqual([expect.objectContaining({ grupos: ['covid'], cnes: [X] })]);
  });
});

describe('aviso-periodo-lido: a cobertura termina na data do primeiro envio do arquivo', () => {
  it('o fim declarado depois do primeiro envio fica na data dele; o período que começa depois não cobre nada, com aviso', async () => {
    const { l } = await lerTudo('x.csv', csvSg([['352400000941', X]]));
    const ano = { de: '2024-01-01', ate: '2024-12-31' };
    expect(l.cobertura(ano, OPCOES.municipio, '2024-11-07').cobertura[0]).toMatchObject({ de: '2024-01-01', ate: '2024-11-07' });
    // Sem o limite (envio sem data), o período declarado inteiro.
    expect(l.cobertura(ano, OPCOES.municipio).cobertura[0]).toMatchObject({ de: '2024-01-01', ate: '2024-12-31' });
    const r = l.cobertura({ de: '2025-01-01', ate: '2025-12-31' }, OPCOES.municipio, '2024-11-07');
    expect(r.cobertura).toEqual([]);
    expect(r.avisos).toContain('O período declarado começa depois do primeiro envio deste arquivo (07/11/2024): nada do período fica marcado como ausente.');
  });
});

describe('imp-planilha-surto: a SEM_PRI da linha de caso do NSURTNET é a do caso', () => {
  const campos: CampoEscrita[] = [
    { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
    { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
    { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
    { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
    { nome: 'SEM_NOT', tipo: 'C', tamanho: 6 },
    { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
    { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
    { nome: 'DT_PRIM_SI', tipo: 'D', tamanho: 8 },
    { nome: 'SEM_PRI', tipo: 'C', tamanho: 6 },
    { nome: 'QT_TOTAL_C', tipo: 'N', tamanho: 4 },
    { nome: 'NU_CASO', tipo: 'N', tamanho: 4 },
    { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
    { nome: 'ID_MUNI_RE', tipo: 'C', tamanho: 6 },
  ];
  const surto = { NU_NOTIFIC: '0000901', TP_NOT: '3', ID_AGRAVO: 'A09', DT_NOTIFIC: '2026-03-12', SEM_NOT: '202610', ID_MUNICIP: '355030', ID_UNIDADE: X, DT_PRIM_SI: '2026-03-07', QT_TOTAL_C: 3 };

  it('com a planilha junto (NU_CASO), a semana do surto sai da DT_PRIM_SI, não da SEM_PRI do primeiro caso', async () => {
    const linha = (caso: number, sinPri: string) => ({ ...surto, NU_CASO: caso, DT_SIN_PRI: sinPri, SEM_PRI: semanaDaData(sinPri).codigo, ID_MUNI_RE: '520870' });
    const { registros } = await lerTudo('NSURTNET.DBF', escreverDbf(campos, [linha(1, '2026-03-09'), linha(2, '2026-03-10'), linha(3, '2026-03-16')]));
    expect(registros).toHaveLength(1);
    const p = registros[0]!.partes[0]!;
    expect(semanaDaData('2026-03-07').codigo).toBe('202609');
    expect(p).toMatchObject({ tipo: 'SURTO', inicioSintomas: '2026-03-07', semanaSintomas: '202609' });
    expect(p.colunas).toContain('semanaSintomas');
  });

  it('sem a planilha, a SEM_PRI da linha é a do surto e continua valendo', async () => {
    const campoSemCaso = campos.filter((c) => !['NU_CASO', 'DT_SIN_PRI', 'ID_MUNI_RE'].includes(c.nome));
    const { registros } = await lerTudo('NSURTNET.DBF', escreverDbf(campoSemCaso, [{ ...surto, SEM_PRI: '202608' }]));
    expect(registros[0]!.partes[0]).toMatchObject({ tipo: 'SURTO', inicioSintomas: '2026-03-07', semanaSintomas: '202608' });
  });
});

describe('N1: leitura do corpo cru (rawBody)', () => {
  const LIMITE = 64 * 1024;
  const OCIOSO = LeituraDoCorpo.ociosoMs;
  const erros: DomainError[] = [];
  let servidor: http.Server;
  let porta = 0;

  beforeAll(async () => {
    servidor = http.createServer((req, res) => {
      // Como no Express (req.res): a resposta de erro sai com Connection: close.
      (req as unknown as { res: http.ServerResponse }).res = res;
      rawBody(req as unknown as Request, LIMITE).then(
        (corpo) => res.end(JSON.stringify({ tamanho: corpo.length, soma: corpo.reduce((a, b) => (a + b) % 65521, 0) })),
        (e: DomainError) => {
          erros.push(e);
          res.statusCode = e.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: e.code, message: e.message }));
        },
      );
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    porta = (servidor.address() as AddressInfo).port;
  });

  afterEach(() => {
    LeituraDoCorpo.ociosoMs = OCIOSO;
    erros.length = 0;
  });

  afterAll(async () => {
    servidor.closeAllConnections();
    await new Promise((ok) => servidor.close(ok));
  });

  /** POST cru: os cabeçalhos dados, o corpo mandado aos poucos por `mandar`. Resolve com a resposta e o fim da conexão. */
  function pedido(cabecalhos: Record<string, string>, mandar: (req: http.ClientRequest) => void) {
    const req = http.request({ hostname: '127.0.0.1', port: porta, method: 'POST', path: '/', headers: { 'content-type': 'application/octet-stream', ...cabecalhos } });
    const inicio = Date.now();
    const resposta = new Promise<{ status: number; corpo: { code?: string; message?: string; tamanho?: number; soma?: number }; ms: number; conexao: string | undefined }>((ok, falha) => {
      req.on('response', (res) => {
        let s = '';
        res.on('data', (c: Buffer) => (s += c.toString()));
        res.on('end', () => ok({ status: res.statusCode!, corpo: JSON.parse(s), ms: Date.now() - inicio, conexao: res.headers.connection }));
      });
      req.on('error', falha);
    });
    resposta.catch(() => undefined);
    const fechou = new Promise<number>((ok) => req.on('close', () => ok(Date.now() - inicio)));
    req.on('error', () => undefined);
    mandar(req);
    return { resposta, fechou, req };
  }

  it('com Content-Length: o corpo exato volta inteiro; sem ele (em pedaços), também', async () => {
    const corpo = Buffer.from(Array.from({ length: 40_000 }, (_, i) => i % 251));
    const soma = corpo.reduce((a, b) => (a + b) % 65521, 0);
    const exato = pedido({ 'content-length': String(corpo.length) }, (r) => r.end(corpo));
    expect(await exato.resposta).toMatchObject({ status: 200, corpo: { tamanho: corpo.length, soma } });
    const emPedacos = pedido({ 'transfer-encoding': 'chunked' }, (r) => {
      r.write(corpo.subarray(0, 10_000));
      r.write(corpo.subarray(10_000, 30_000));
      r.end(corpo.subarray(30_000));
    });
    expect(await emPedacos.resposta).toMatchObject({ status: 200, corpo: { tamanho: corpo.length, soma } });
  });

  it('o corpo que para de chegar: 408 no prazo de ociosidade e a conexão fechada', async () => {
    LeituraDoCorpo.ociosoMs = 300;
    const lento = pedido({ 'content-length': '1000' }, (r) => r.write(Buffer.alloc(10, 0x41)));
    const r = await lento.resposta;
    expect(r).toMatchObject({ status: 408, corpo: { code: 'ENVIO_PARADO', message: 'O envio parou de chegar. Envie o arquivo de novo.' }, conexao: 'close' });
    expect(r.ms).toBeGreaterThanOrEqual(280);
    expect(r.ms).toBeLessThan(3000);
    expect(await lento.fechou).toBeLessThan(3000);
  });

  it('pedaço a pedaço o prazo recomeça: o envio lento que não para chega inteiro', async () => {
    LeituraDoCorpo.ociosoMs = 400;
    const corpo = Buffer.alloc(600, 0x42);
    const passo = pedido({ 'content-length': String(corpo.length) }, (r) => {
      let i = 0;
      const t = setInterval(() => {
        if (i >= corpo.length) {
          clearInterval(t);
          r.end();
          return;
        }
        r.write(corpo.subarray(i, i + 100));
        i += 100;
      }, 150);
    });
    expect(await passo.resposta).toMatchObject({ status: 200, corpo: { tamanho: 600 } });
  });

  it('Content-Length acima do limite: 413 antes de ler o corpo, e a conexão fecha', async () => {
    const grande = pedido({ 'content-length': String(LIMITE + 1) }, (r) => r.write(Buffer.alloc(100, 0x43)));
    const r = await grande.resposta;
    expect(r).toMatchObject({ status: 413, corpo: { code: 'ARQUIVO_GRANDE' }, conexao: 'close' });
    expect(await grande.fechou).toBeLessThan(3000);
    // Sem Content-Length, o 413 sai quando o corpo passa do limite.
    const emPedacos = pedido({ 'transfer-encoding': 'chunked' }, (r2) => {
      r2.write(Buffer.alloc(LIMITE, 0x44));
      r2.write(Buffer.alloc(10, 0x44));
    });
    expect(await emPedacos.resposta).toMatchObject({ status: 413, corpo: { code: 'ARQUIVO_GRANDE' } });
    emPedacos.req.destroy();
  });

  it('mais bytes que o Content-Length, ou o fim antes dele: 400 (o fluxo do pedido simulado, que o parser HTTP do Node não deixa passar)', async () => {
    /** Pedido simulado: o Content-Length declarado e os bytes entregues de fato. */
    const simulado = (declarado: number, entregues: number) => {
      const r = Readable.from([Buffer.alloc(entregues, 0x46)], { objectMode: false }) as Readable & { headers: Record<string, string>; complete: boolean };
      r.headers = { 'content-length': String(declarado) };
      r.complete = false;
      r.on('end', () => (r.complete = true));
      return r as unknown as Request;
    };
    await expect(rawBody(simulado(10, 20), LIMITE)).rejects.toMatchObject({ status: 400, code: 'ENVIO_INVALIDO', message: 'O envio trouxe mais bytes que o tamanho declarado. Envie o arquivo de novo.' });
    await expect(rawBody(simulado(100, 50), LIMITE)).rejects.toMatchObject({ status: 400, code: 'ENVIO_INCOMPLETO', message: 'O envio chegou incompleto. Envie o arquivo de novo.' });
    expect((await rawBody(simulado(30, 30), LIMITE)).length).toBe(30);
  });

  it('o cliente que cai no meio: o envio termina com erro (corpo incompleto), sem ficar esperando', async () => {
    LeituraDoCorpo.ociosoMs = 60_000;
    const caiu = pedido({ 'content-length': '1000' }, (r) => {
      r.write(Buffer.alloc(500, 0x45));
      setTimeout(() => r.destroy(), 100);
    });
    await caiu.fechou;
    const fim = Date.now() + 3000;
    while (!erros.length && Date.now() < fim) await new Promise((r) => setTimeout(r, 20));
    expect(erros.map((e) => [e.status, e.code, e.message])).toEqual([[400, 'ENVIO_INCOMPLETO', 'O envio chegou incompleto. Envie o arquivo de novo.']]);
  });
});
