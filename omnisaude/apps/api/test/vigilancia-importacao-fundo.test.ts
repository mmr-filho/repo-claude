import { randomUUID } from 'node:crypto';
import { semanaDaData, type DetalheImportacao, type EtapaImportacao } from '@omnisaude/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { DomainError } from '../src/core/errors';
import { ImportacaoService } from '../src/modules/vigilancia/importacao.service';
import { CAMPOS_NINDINET, escreverDbf, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';

/**
 * Importação em segundo plano (VIG-1c, segunda rodada): a leitura e a aplicação rodam no processo da API e o pedido
 * espera até `ImportacaoService.esperaMs`. Dentro da espera, as respostas de sempre (201, 200, 422 sem linha); depois,
 * 202 e a tela acompanha pelo detalhe até PREVIA, FALHOU ou APLICADA. O sinal de vida (working_at) avança durante o
 * trabalho; parado há mais de 2 min, fora do processo, é trabalho interrompido. Os testes seguram o trabalho com o
 * gancho de teste do serviço (sem depender do tempo da máquina) e a espera 0 força o caminho lento. Dados sintéticos.
 */

const enabled = await pgAvailable();
const MUN = '355030';
const UBS = '9000011';
const ESPERA_PADRAO = ImportacaoService.esperaMs;
const SINAL_PADRAO = ImportacaoService.sinalMs;

/** Segura o trabalho na etapa até `soltar()`; `chegou` resolve quando o trabalho para no gancho. */
function segurar(etapa: EtapaImportacao) {
  let soltar = () => {};
  let marcarChegada = () => {};
  const solto = new Promise<void>((r) => (soltar = r));
  const chegou = new Promise<void>((r) => (marcarChegada = r));
  ImportacaoService.ganchoDeTeste = async (e) => {
    if (e !== etapa) return;
    marcarChegada();
    await solto;
  };
  return { chegou, soltar };
}

/** Falha a etapa depois de `atrasoMs` (o atraso garante que o pedido já respondeu 202 com a espera 0). */
function falhar(etapa: EtapaImportacao, erro: Error, atrasoMs = 50) {
  ImportacaoService.ganchoDeTeste = async (e) => {
    if (e !== etapa) return;
    await new Promise((r) => setTimeout(r, atrasoMs));
    throw erro;
  };
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(enabled)('importação em segundo plano: 202, acompanhamento, falhas e sinal de vida', () => {
  let t: TestApp;
  let vig = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let seq = 0;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  const nindinet = (n: string, dt: string, v: Record<string, ValorEscrita> = {}) => ({
    NU_NOTIFIC: n,
    TP_NOT: '2',
    ID_AGRAVO: 'A279',
    DT_NOTIFIC: dt,
    SEM_NOT: semanaDaData(dt).codigo,
    NU_ANO: dt.slice(0, 4),
    SG_UF_NOT: '35',
    ID_MUNICIP: MUN,
    ID_UNIDADE: UBS,
    SG_UF: '35',
    ID_MN_RESI: MUN,
    NM_PACIENT: `PACIENTE FUNDO ${n}`,
    CS_SEXO: 'F',
    ...v,
  });
  /** NINDINET com `n` registros novos (números a partir de `base`). */
  const arquivo = (n: number) => {
    seq++;
    const base = 8_100_000 + seq * 1000;
    return {
      bytes: escreverDbf(
        CAMPOS_NINDINET,
        Array.from({ length: n }, (_, i) => nindinet(String(base + i), `2024-05-${String(1 + (i % 28)).padStart(2, '0')}`)),
      ),
      base,
    };
  };
  /** CSV sem nenhuma coluna conhecida: a leitura recusa (SEM_REGISTROS, 422). */
  const desconhecido = () => new TextEncoder().encode(`coluna qualquer;outra coluna\r\n${++seq};x\r\n`);

  const enviar = (bytes: Uint8Array, nome: string) => t.http().post('/api/vigilancia/importacoes').query({ nome }).set(auth(vig)).set('Content-Type', 'application/octet-stream').send(Buffer.from(bytes));
  const aplicar = (id: string) => t.http().post(`/api/vigilancia/importacoes/${id}/aplicar`).set(auth(vig));
  const detalhe = async (id: string) => (await t.http().get(`/api/vigilancia/importacoes/${id}`).set(auth(vig)).expect(200)).body as DetalheImportacao;
  /**
   * Consulta o detalhe até `pronto` (como a tela faz), com teto de tempo. Depois espera o trabalho soltar a vez do
   * processo (a linha fica pronta um instante antes), para o próximo envio não receber 409.
   */
  const acompanhar = async (id: string, pronto: (d: DetalheImportacao) => boolean) => {
    const fim = Date.now() + 20_000;
    for (;;) {
      const d = await detalhe(id);
      if (pronto(d)) {
        await ImportacaoService.aguardarTrabalhos();
        return d;
      }
      if (Date.now() > fim) throw new Error(`acompanhamento sem fim: ${d.status} ${JSON.stringify(d.processamento)}`);
      await pausa(50);
    }
  };
  const sinal = async (id: string) => (await db.officialImport.findUniqueOrThrow({ where: { id }, select: { workingAt: true } })).workingAt;
  /** Prévia pronta pelo caminho rápido. */
  const previaPronta = async (n = 2) => {
    const a = arquivo(n);
    const r = await enviar(a.bytes, `fundo-${seq}.dbf`).expect(201);
    return { d: r.body as DetalheImportacao, ...a };
  };

  beforeAll(async () => {
    t = await startTestApp('vigimpfundo');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
  }, 120_000);

  afterEach(async () => {
    ImportacaoService.ganchoDeTeste = null;
    await ImportacaoService.aguardarTrabalhos();
    ImportacaoService.esperaMs = ESPERA_PADRAO;
    ImportacaoService.sinalMs = SINAL_PADRAO;
  });

  afterAll(async () => {
    ImportacaoService.ganchoDeTeste = null;
    await ImportacaoService.aguardarTrabalhos();
    await t?.close();
  });

  it('caminho lento: 202 com o que se sabe, LENDO no detalhe, e a prévia igual à do caminho rápido', async () => {
    const a = arquivo(3);
    // Caminho rápido (dentro da espera): 201 com a prévia, como sempre.
    const rapida = (await enviar(a.bytes, 'lento.dbf').expect(201)).body as DetalheImportacao;
    expect(rapida).toMatchObject({ status: 'PREVIA', processamento: null, erro: null, resultadoAplicacao: null });

    // O mesmo arquivo pelo caminho lento.
    ImportacaoService.esperaMs = 0;
    const s = segurar('LENDO');
    const r = await enviar(a.bytes, 'lento.dbf').expect(202);
    expect(r.body).toEqual({ id: expect.any(String), status: 'PROCESSANDO', arquivo: 'lento.dbf', tamanhoBytes: a.bytes.length, desde: expect.any(String) });
    const id = r.body.id as string;
    await s.chegou;
    const lendo = await detalhe(id);
    expect(lendo).toMatchObject({ status: 'PROCESSANDO', sistema: null, contagens: null, previa: null, erro: null, expiraEm: null, arquivo: 'lento.dbf', sha256: rapida.sha256 });
    expect(lendo.processamento).toMatchObject({ etapa: 'LENDO', desde: r.body.desde });
    // Enquanto lê, não dá para aplicar nem descartar.
    expect((await aplicar(id).expect(409)).body.message).toContain('A prévia ainda está sendo preparada');
    await t.http().post(`/api/vigilancia/importacoes/${id}/descartar`).set(auth(vig)).expect(409);
    const lista = (await t.http().get('/api/vigilancia/importacoes').set(auth(vig)).expect(200)).body as DetalheImportacao[];
    expect(lista.find((i) => i.id === id)).toMatchObject({ status: 'PROCESSANDO', processamento: { etapa: 'LENDO' } });

    s.soltar();
    const pronta = await acompanhar(id, (d) => d.status !== 'PROCESSANDO');
    const comparavel = (d: DetalheImportacao) => ({
      status: d.status,
      sistema: d.sistema,
      periodo: d.periodo,
      periodoDeclarado: d.periodoDeclarado,
      identificado: d.identificado,
      contagens: d.contagens,
      arquivos: d.arquivos,
      previa: d.previa,
      avisos: d.avisos,
      processamento: d.processamento,
      erro: d.erro,
    });
    expect(comparavel(pronta)).toEqual(comparavel(rapida));
    expect(pronta.expiraEm).not.toBeNull();
    // A prévia anterior do mesmo arquivo foi descartada pela nova.
    expect((await detalhe(rapida.id)).status).toBe('DESCARTADA');
    // O contexto do pedido continua valendo depois da resposta: a auditoria da prévia tem o usuário, o papel e o IP.
    const linha = await db.officialImport.findUniqueOrThrow({ where: { id }, select: { createdBy: true } });
    const trilha = await db.auditEntry.findFirstOrThrow({ where: { entityType: 'OfficialImport', entityId: id, action: 'vigilancia.importacao_previa' } });
    expect(trilha).toMatchObject({ userId: linha.createdBy, role: 'VIGILANCIA_EPIDEMIOLOGICA' });
    expect(trilha.ip).toBeTruthy();
  });

  it('falha dentro da espera: o mesmo 422 de sempre, sem linha; depois do 202: FALHOU com o código e a mensagem, aplicar dá 409', async () => {
    const bytes = desconhecido();
    const antes = await db.officialImport.count();
    const sincrono = (await enviar(bytes, 'desconhecido.csv').expect(422)).body;
    expect(sincrono).toMatchObject({ code: 'SEM_REGISTROS', message: expect.stringContaining('Nenhum arquivo com notificações reconhecidas') });
    expect(await db.officialImport.count()).toBe(antes);

    ImportacaoService.esperaMs = 0;
    // O gancho só atrasa a leitura (a falha é a do arquivo): sem ele, a leitura de um arquivo minúsculo poderia acabar
    // antes de a espera 0 vencer.
    ImportacaoService.ganchoDeTeste = async () => {
      await pausa(50);
    };
    const r = await enviar(bytes, 'desconhecido.csv').expect(202);
    const falhou = await acompanhar(r.body.id as string, (d) => d.status !== 'PROCESSANDO');
    expect(falhou).toMatchObject({ status: 'FALHOU', processamento: null, contagens: null, sistema: null, previa: null });
    expect(falhou.erro).toEqual({ codigo: 'SEM_REGISTROS', mensagem: sincrono.message, detalhes: sincrono.details });
    expect(await db.officialImport.count()).toBe(antes + 1);
    expect((await aplicar(falhou.id).expect(409)).body.message).toContain('envie o arquivo de novo');
    // A FALHOU pode ser descartada (sai das pendências; o erro fica no histórico).
    await t.http().post(`/api/vigilancia/importacoes/${falhou.id}/descartar`).set(auth(vig)).expect(200);
    expect(await detalhe(falhou.id)).toMatchObject({ status: 'DESCARTADA', expirada: false, erro: { codigo: 'SEM_REGISTROS' } });
  });

  it('aplicação lenta: 202, segundo aplicar e descartar durante APLICANDO dão 409, e o resultado fica guardado', async () => {
    const { d, base } = await previaPronta(3);
    ImportacaoService.esperaMs = 0;
    const s = segurar('APLICANDO');
    const r = await aplicar(d.id).expect(202);
    expect(r.body).toEqual({ id: d.id, status: 'APLICANDO' });
    await s.chegou;
    const aplicando = await detalhe(d.id);
    expect(aplicando).toMatchObject({ status: 'PREVIA', processamento: { etapa: 'APLICANDO' }, erro: null });
    expect((await aplicar(d.id).expect(409)).body.message).toContain('já está sendo aplicada');
    expect((await t.http().post(`/api/vigilancia/importacoes/${d.id}/descartar`).set(auth(vig)).expect(409)).body.message).toContain('sendo aplicada');
    s.soltar();
    const aplicada = await acompanhar(d.id, (x) => !x.processamento);
    expect(aplicada).toMatchObject({ status: 'APLICADA', erro: null });
    expect(aplicada.resultadoAplicacao).toMatchObject({ id: d.id, contagens: { novos: 3, alterados: 0 }, unidadesLigadas: 3, negativasCanceladas: 0, avisos: [] });
    expect(aplicada.resultadoAplicacao!.aplicadoEm).toBe(aplicada.aplicadoEm);
    expect(await db.officialRecord.count({ where: { number: { in: [String(base), String(base + 1), String(base + 2)] } } })).toBe(3);
    // O caminho rápido também guarda o resultado (a lista mostra o mesmo que a resposta 200).
    ImportacaoService.esperaMs = ESPERA_PADRAO;
    const outra = await previaPronta(1);
    const r200 = (await aplicar(outra.d.id).expect(200)).body;
    expect((await detalhe(outra.d.id)).resultadoAplicacao).toEqual(r200);
  });

  it('falha da aplicação: dentro da espera volta o erro sem gravar nada; depois do 202 a PREVIA guarda o erro e aplicar de novo funciona', async () => {
    const { d, base } = await previaPronta(2);
    // Dentro da espera: o erro de sempre (aqui um 409 simulado), sem marca nem erro gravado.
    ImportacaoService.ganchoDeTeste = async (e) => {
      if (e === 'APLICANDO') throw new DomainError('CONFLITO', 'Conflito simulado', 409);
    };
    expect((await aplicar(d.id).expect(409)).body).toMatchObject({ code: 'CONFLITO', message: 'Conflito simulado' });
    expect(await detalhe(d.id)).toMatchObject({ status: 'PREVIA', processamento: null, erro: null });

    // Depois do 202: erro inesperado vira ERRO_INTERNO na linha (sem o texto interno), a PREVIA continua aplicável.
    ImportacaoService.esperaMs = 0;
    falhar('APLICANDO', new Error('conexão perdida no meio'));
    await aplicar(d.id).expect(202);
    const falhou = await acompanhar(d.id, (x) => !x.processamento);
    expect(falhou).toMatchObject({ status: 'PREVIA', erro: { codigo: 'ERRO_INTERNO' } });
    expect(falhou.erro!.mensagem).toContain('nada foi gravado');
    expect(falhou.erro!.mensagem).not.toContain('conexão perdida');
    expect(await db.officialRecord.count({ where: { number: { in: [String(base), String(base + 1)] } } })).toBe(0);

    ImportacaoService.ganchoDeTeste = null;
    ImportacaoService.esperaMs = ESPERA_PADRAO;
    expect((await aplicar(d.id).expect(200)).body.contagens).toMatchObject({ novos: 2 });
    expect(await detalhe(d.id)).toMatchObject({ status: 'APLICADA', erro: null, processamento: null });
  });

  it('sinal de vida parado há mais de 2 min fora do processo: a leitura vira FALHOU e a aplicação perde a marca (e pode ser aplicada)', async () => {
    const velho = new Date(Date.now() - 3 * 60_000);
    const linha = (dados: { workingAt: Date; fileName: string }) =>
      db.officialImport.create({
        data: {
          id: randomUUID(),
          status: 'PROCESSANDO',
          fileName: dados.fileName,
          sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          sizeBytes: 10,
          createdBy: randomUUID(),
          workingStep: 'LENDO',
          workingSince: velho,
          workingAt: dados.workingAt,
        },
        select: { id: true },
      });
    // Detalhe.
    const parada = await linha({ workingAt: velho, fileName: 'parada.dbf' });
    expect(await detalhe(parada.id)).toMatchObject({
      status: 'FALHOU',
      processamento: null,
      erro: { codigo: 'LEITURA_INTERROMPIDA', mensagem: 'A leitura do arquivo foi interrompida (o servidor reiniciou). Envie o arquivo de novo.' },
    });
    // Sinal recente (de outro processo): continua PROCESSANDO.
    const viva = await linha({ workingAt: new Date(), fileName: 'viva.dbf' });
    expect(await detalhe(viva.id)).toMatchObject({ status: 'PROCESSANDO', processamento: { etapa: 'LENDO' } });
    // Lista e job das prévias vencidas.
    const naLista = await linha({ workingAt: velho, fileName: 'na-lista.dbf' });
    const lista = (await t.http().get('/api/vigilancia/importacoes').set(auth(vig)).expect(200)).body as DetalheImportacao[];
    expect(lista.find((i) => i.id === naLista.id)).toMatchObject({ status: 'FALHOU', erro: { codigo: 'LEITURA_INTERROMPIDA' } });
    await db.officialImport.update({ where: { id: viva.id }, data: { workingAt: velho } });
    await t.app.get(ImportacaoService).expirarPrevias(db, new Date(), 24);
    expect(await db.officialImport.findUniqueOrThrow({ where: { id: viva.id } })).toMatchObject({ status: 'FALHOU', workingStep: null, workingAt: null });

    // Aplicação: marca recente de outro processo dá 409; parada há mais de 2 min sai com o erro e a prévia é aplicável.
    const { d } = await previaPronta(2);
    await db.officialImport.update({ where: { id: d.id }, data: { workingStep: 'APLICANDO', workingSince: new Date(), workingAt: new Date() } });
    expect((await aplicar(d.id).expect(409)).body.message).toContain('já está sendo aplicada');
    await db.officialImport.update({ where: { id: d.id }, data: { workingSince: velho, workingAt: velho } });
    expect(await detalhe(d.id)).toMatchObject({
      status: 'PREVIA',
      processamento: null,
      erro: { codigo: 'APLICACAO_INTERROMPIDA', mensagem: 'A aplicação foi interrompida antes de terminar; nada foi gravado. Aplique de novo.' },
    });
    expect((await aplicar(d.id).expect(200)).body.contagens).toMatchObject({ novos: 2 });
  });

  it('segundo envio (e aplicar) durante um trabalho dá 409 IMPORTACAO_OCUPADA; depois que ele acaba, passa', async () => {
    const outra = await previaPronta(1);
    ImportacaoService.esperaMs = 0;
    const s = segurar('LENDO');
    const r = await enviar(arquivo(2).bytes, 'primeiro.dbf').expect(202);
    await s.chegou;
    const segundo = arquivo(2).bytes;
    expect((await enviar(segundo, 'segundo.dbf').expect(409)).body).toMatchObject({ code: 'IMPORTACAO_OCUPADA', message: expect.stringContaining('Outra importação está sendo processada') });
    expect((await aplicar(outra.d.id).expect(409)).body).toMatchObject({ code: 'IMPORTACAO_OCUPADA' });
    s.soltar();
    expect((await acompanhar(r.body.id as string, (d) => d.status !== 'PROCESSANDO')).status).toBe('PREVIA');
    ImportacaoService.esperaMs = ESPERA_PADRAO;
    expect((await enviar(segundo, 'segundo.dbf').expect(201)).body.status).toBe('PREVIA');
  });

  it('o sinal de vida avança durante o trabalho lento (leitura e aplicação) e não toca a linha concluída', async () => {
    ImportacaoService.sinalMs = 40;
    ImportacaoService.esperaMs = 0;
    const lendo = segurar('LENDO');
    const r = await enviar(arquivo(2).bytes, 'sinal.dbf').expect(202);
    const id = r.body.id as string;
    await lendo.chegou;
    const s1 = await sinal(id);
    await pausa(250);
    const s2 = await sinal(id);
    expect(s2!.getTime()).toBeGreaterThan(s1!.getTime());
    expect((await detalhe(id)).processamento!.atualizadoEm).not.toBe(r.body.desde);
    lendo.soltar();
    await acompanhar(id, (d) => d.status === 'PREVIA');
    await pausa(150);
    expect(await sinal(id)).toBeNull();

    const aplicando = segurar('APLICANDO');
    await aplicar(id).expect(202);
    await aplicando.chegou;
    const a1 = await sinal(id);
    await pausa(250);
    expect((await sinal(id))!.getTime()).toBeGreaterThan(a1!.getTime());
    aplicando.soltar();
    expect(await acompanhar(id, (d) => !d.processamento)).toMatchObject({ status: 'APLICADA' });
    await pausa(150);
    expect(await db.officialImport.findUniqueOrThrow({ where: { id }, select: { workingStep: true, workingAt: true, status: true } })).toEqual({ workingStep: null, workingAt: null, status: 'APLICADA' });
  });
});
