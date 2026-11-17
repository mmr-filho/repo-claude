import {
  ROTULO_TIPO_REGISTRO,
  type AplicacaoEmAndamento,
  type ArquivoDetectado,
  type ArquivoJaImportado,
  type CodificacaoArquivo,
  type ContagensImportacao,
  type DetalheImportacao,
  type EnvioEmProcessamento,
  type ImportacaoDoMesmoArquivo,
  type RespostaAplicacao,
  type RespostaEnvioImportacao,
  type ResultadoAplicacao,
  type ResumoImportacao,
  type TipoArquivoOficial,
  type TipoRegistroOficial,
} from '@omnisaude/shared';
import { api, ApiError, errorMessage } from '@/lib/api';

/*
 * Regras da aba Importação (envio das exportações oficiais, prévia, aplicar e descartar), sem React (testadas em
 * apps/web/test/importacao-regras.test.ts). Os limites são os da API.
 */

/** Teto do envio na API, antes de descompactar. */
export const LIMITE_ENVIO_BYTES = 95 * 1024 * 1024;

/** O que a API aceita num envio (os tetos de importacao/limites.ts da API). */
export const TEXTO_LIMITES_ENVIO = 'Zip, DBF ou CSV de até 95 MB (até 150 MB descompactados e 400 mil registros por envio)';

/** O zip da exportação, o DBF do Sinan ou o CSV do e-SUS (a API detecta o tipo pelo conteúdo, nunca pelo nome). */
export const EXTENSOES_ENVIO = ['.zip', '.dbf', '.csv'] as const;

const extensao = (nome: string) => /\.[^./\\]+$/.exec(nome.toLowerCase())?.[0] ?? '';

/** Tamanho legível: "830 bytes", "12,5 KB", "4,2 MB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n.toLocaleString('pt-BR')} bytes`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`;
  return `${(kb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

/** Confere o arquivo antes do envio: extensão e tamanho. Devolve o problema ou null. */
export function conferirArquivo(arquivo: { name: string; size: number }): string | null {
  if (!(EXTENSOES_ENVIO as readonly string[]).includes(extensao(arquivo.name))) return 'Envie o zip da exportação, o DBF do Sinan ou o CSV do e-SUS (.zip, .dbf ou .csv).';
  if (arquivo.size === 0) return 'O arquivo está vazio.';
  if (arquivo.size > LIMITE_ENVIO_BYTES) return `O arquivo passa de ${fmtBytes(LIMITE_ENVIO_BYTES)}: exporte por período menor.`;
  return null;
}

/** Período declarado: os dois ou nenhum, e o início antes do fim. Devolve o problema ou null. */
export function conferirPeriodo(de: string, ate: string): string | null {
  if (!de && !ate) return null;
  if (!de || !ate) return 'Informe o início e o fim do período, ou deixe os dois em branco.';
  if (de > ate) return 'O início do período vem depois do fim.';
  return null;
}

/** Consulta do envio (POST /vigilancia/importacoes): nome do arquivo e, se preenchidos, período e codificação. */
export function consultaDoEnvio(c: { nome: string; de?: string; ate?: string; codificacao?: CodificacaoArquivo | '' | null }): string {
  // A API aceita até 255 caracteres no nome.
  const q = new URLSearchParams({ nome: c.nome.slice(0, 255) });
  if (c.de && c.ate) {
    q.set('de', c.de);
    q.set('ate', c.ate);
  }
  if (c.codificacao) q.set('codificacao', c.codificacao);
  return `?${q.toString()}`;
}

/** O mesmo arquivo (SHA-256) já foi aplicado: a API não criou nada. */
export const jaImportado = (r: RespostaEnvioImportacao): r is ArquivoJaImportado => 'jaImportado' in r;

/** 202 do envio: a leitura continua no servidor e a tela acompanha pelo detalhe. */
export const envioEmProcessamento = (r: RespostaEnvioImportacao): r is EnvioEmProcessamento => !('jaImportado' in r) && r.status === 'PROCESSANDO' && !('sha256' in r);

/** 202 do aplicar: a aplicação continua no servidor e a tela acompanha pelo detalhe. */
export const aplicacaoEmAndamento = (r: RespostaAplicacao): r is AplicacaoEmAndamento => 'status' in r && r.status === 'APLICANDO';

/**
 * Situação da importação na lista e no detalhe: a leitura e a aplicação em andamento no servidor, a que falhou, a
 * aplicada que outra aplicação do mesmo arquivo substituiu ("Substituída") e a prévia descartada pelo tempo
 * ("Expirada").
 */
export function situacaoImportacao(r: Pick<ResumoImportacao, 'status' | 'expirada'> & Partial<Pick<ResumoImportacao, 'processamento'>>): { rotulo: string; tom: 'blue' | 'green' | 'amber' | 'slate' | 'red' | 'violet' } {
  if (r.status === 'PROCESSANDO' || r.processamento?.etapa === 'LENDO') return { rotulo: 'Lendo o arquivo…', tom: 'violet' };
  if (r.status === 'SUBSTITUIDA') return { rotulo: 'Substituída', tom: 'slate' };
  if (r.processamento?.etapa === 'APLICANDO') return { rotulo: 'Aplicando…', tom: 'violet' };
  if (r.status === 'FALHOU') return { rotulo: 'Falhou', tom: 'red' };
  if (r.status === 'PREVIA') return { rotulo: 'Prévia', tom: 'blue' };
  if (r.status === 'APLICADA') return { rotulo: 'Aplicada', tom: 'green' };
  return r.expirada ? { rotulo: 'Expirada', tom: 'amber' } : { rotulo: 'Descartada', tom: 'slate' };
}

const periodoBr = (p: ImportacaoDoMesmoArquivo['periodo'], declarado: boolean) => (p ? `período ${dataBr(p.de)} a ${dataBr(p.ate)}, ${declarado ? 'declarado' : 'lido das notificações'}` : 'sem período');

/**
 * Detalhe da SUBSTITUIDA: por qual aplicação do mesmo arquivo foi substituída, com a data. `dataHora` formata o instante
 * no fuso do município.
 */
export function textoSubstituidaPor(r: Pick<ResumoImportacao, 'status' | 'substituidaPor'>, dataHora: (iso: string) => string): string | null {
  const s = r.substituidaPor;
  if (r.status !== 'SUBSTITUIDA' || !s) return null;
  const quando = s.aplicadaEm ? `aplicado em ${dataHora(s.aplicadaEm)}` : `enviado em ${dataHora(s.enviadaEm)}`;
  return `Substituída pelo envio do mesmo arquivo de ${dataHora(s.enviadaEm)} (${periodoBr(s.periodo, s.periodoDeclarado)}), ${quando}. A cobertura e os ausentes passaram a ser os dele.`;
}

/**
 * Mensagem do erro gravado na linha, como aparece no histórico: a da leitura que falhou, ou a da última aplicação que
 * não terminou (a prévia continua aplicável). Depois de descartada ou aplicada, o histórico não repete o erro.
 */
export function mensagemDoErroGravado(r: Pick<ResumoImportacao, 'status' | 'erro'>): string | null {
  if (!r.erro) return null;
  if (r.status === 'FALHOU') return r.erro.mensagem;
  return r.status === 'PREVIA' ? `A última tentativa de aplicar não terminou: ${r.erro.mensagem}` : null;
}

// ───────────── respostas que não chegaram e erros com mensagem pronta ─────────────

/** Falha de rede (0) e as respostas do proxy e da borda (502, 503, 504 e 524): o pedido pode ter chegado à API. */
export const STATUS_RESPOSTA_PERDIDA: readonly number[] = [0, 502, 503, 504, 524];

export const MENSAGEM_ENVIO_SEM_RESPOSTA = 'A resposta não chegou. Se o arquivo foi recebido, a prévia aparece no histórico em instantes.';
export const MENSAGEM_APLICAR_SEM_RESPOSTA = 'A resposta não chegou. Se a aplicação começou, ela aparece nesta tela em instantes.';
/** 409 IMPORTACAO_OCUPADA: outra importação do próprio município lendo ou aplicando (aparece no histórico). */
export const MENSAGEM_IMPORTACAO_OCUPADA = 'Outra importação está sendo lida ou aplicada agora (uma por vez). Acompanhe no histórico e tente de novo quando ela terminar.';
/** 409 IMPORTACAO_SERVIDOR_OCUPADO sem mensagem da API (a API sempre manda a dela: o servidor ocupado com outros envios). */
export const MENSAGEM_SERVIDOR_OCUPADO = 'O servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.';

/** A resposta do pedido se perdeu no caminho (rede, proxy ou borda): o trabalho pode estar rodando no servidor. */
export const respostaPerdida = (status: number | null | undefined) => status !== null && status !== undefined && STATUS_RESPOSTA_PERDIDA.includes(status);

/**
 * Título e tom do alerta do envio que deu erro. A resposta que não chegou é aviso, não erro: o arquivo pode ter sido
 * recebido e a prévia aparecer no histórico.
 */
export function alertaDoErroDeEnvio(status: number | null | undefined): { tom: 'warn' | 'error'; titulo: string } {
  return respostaPerdida(status) ? { tom: 'warn', titulo: 'A resposta do envio não chegou' } : { tom: 'error', titulo: 'O envio não gerou prévia' };
}

/**
 * Mensagem do erro do envio ou do aplicar: a resposta que não chegou, outra importação do município em andamento (a
 * tela manda acompanhar no histórico), o servidor ocupado com outros envios (a mensagem da API: pode ser de outro
 * município, que não aparece no histórico) ou a mensagem da API.
 */
export function mensagemDoErro(acao: 'enviar' | 'aplicar', erro: { status?: number | null; code?: string | null; message: string }): string {
  if (respostaPerdida(erro.status)) return acao === 'enviar' ? MENSAGEM_ENVIO_SEM_RESPOSTA : MENSAGEM_APLICAR_SEM_RESPOSTA;
  if (erro.code === 'IMPORTACAO_OCUPADA') return MENSAGEM_IMPORTACAO_OCUPADA;
  if (erro.code === 'IMPORTACAO_SERVIDOR_OCUPADO') return erro.message.trim() || MENSAGEM_SERVIDOR_OCUPADO;
  return erro.message;
}

// ───────────── acompanhamento do trabalho em segundo plano ─────────────

/** O que a tela acompanha: a leitura do arquivo (depois do 202 do envio) ou a aplicação (depois do 202 do aplicar). */
export type AlvoAcompanhamento = 'LEITURA' | 'APLICACAO';

export const ACOMPANHAMENTO = {
  /** Primeira consulta e intervalo inicial. */
  inicialMs: 2000,
  /** Recuo: o intervalo cresce 50% a cada consulta, até este teto. */
  tetoMs: 5000,
  /** Falhas passageiras seguidas (rede, 502, 503, 504, 524) toleradas antes de parar (uns 2 min no teto). */
  falhasToleradas: 24,
  /** A partir de quantas falhas seguidas a tela avisa que está sem resposta. */
  falhasParaAvisar: 2,
} as const;

export interface EstadoAcompanhamento {
  alvo: AlvoAcompanhamento;
  /** Espera até a próxima consulta. */
  intervaloMs: number;
  /** Falhas passageiras seguidas. */
  falhas: number;
}

/** Resultado de uma consulta ao detalhe (GET /vigilancia/importacoes/:id). */
export type LeituraAcompanhamento = { ok: true; detalhe: DetalheImportacao } | { ok: false; status: number; mensagem: string };

export type PassoAcompanhamento =
  /** Continua: consulta de novo em `estado.intervaloMs`. */
  | { tipo: 'esperar'; estado: EstadoAcompanhamento; detalhe: DetalheImportacao | null; aviso: string | null }
  /** A leitura terminou: a prévia está pronta (ou a importação mudou de outro jeito): abre o detalhe. */
  | { tipo: 'previa'; detalhe: DetalheImportacao }
  /** A aplicação terminou: o resultado guardado (null nas aplicadas antes de ele ser guardado). */
  | { tipo: 'aplicada'; detalhe: DetalheImportacao; resultado: ResultadoAplicacao | null }
  /** A leitura falhou (FALHOU) ou a aplicação não terminou (PREVIA com erro). */
  | { tipo: 'falhou'; detalhe: DetalheImportacao | null; mensagem: string }
  /** Para de acompanhar (importação sumiu, sem permissão, ou sem resposta por muito tempo). */
  | { tipo: 'parar'; mensagem: string };

export const iniciarAcompanhamento = (alvo: AlvoAcompanhamento): EstadoAcompanhamento => ({ alvo, intervaloMs: ACOMPANHAMENTO.inicialMs, falhas: 0 });

/**
 * O detalhe no modo de acompanhamento: a situação, o processamento, o erro e o resultado, sem a prévia nominal (que é
 * auditada a cada leitura) e sem ir para a auditoria.
 */
export const caminhoDoAcompanhamento = (id: string) => `/vigilancia/importacoes/${id}?acompanhar=1`;

/** Uma consulta do acompanhamento (a cada 2 a 5 s enquanto o servidor lê ou aplica). */
export async function lerAcompanhamento(id: string): Promise<LeituraAcompanhamento> {
  try {
    return { ok: true, detalhe: await api.get<DetalheImportacao>(caminhoDoAcompanhamento(id)) };
  } catch (err) {
    return { ok: false, status: err instanceof ApiError ? err.status : 0, mensagem: errorMessage(err) };
  }
}

/**
 * O detalhe novo com a prévia que a tela já tem, quando ele vem sem ela (acompanhamento, aplicação em andamento) e a
 * importação continua uma prévia (aplicando, ou a aplicação que não terminou). Aplicada, descartada ou expirada, a prévia
 * sai da tela.
 */
export function comPreviaCarregada(anterior: DetalheImportacao | null, novo: DetalheImportacao): DetalheImportacao {
  if (novo.previa || novo.status !== 'PREVIA' || !anterior?.previa || anterior.id !== novo.id) return novo;
  return { ...novo, previa: anterior.previa };
}

const recuar = (ms: number) => Math.min(ACOMPANHAMENTO.tetoMs, Math.round(ms * 1.5));

/**
 * Máquina de estados do acompanhamento: a partir da consulta ao detalhe, continua (com recuo de 2 s até 5 s), abre a
 * prévia, mostra o resultado da aplicação ou a falha, ou para. A falha passageira (rede, 502, 503, 504, 524) não
 * interrompe: a tela avisa e tenta de novo, até o limite.
 */
export function proximoPasso(estado: EstadoAcompanhamento, leitura: LeituraAcompanhamento): PassoAcompanhamento {
  if (!leitura.ok) {
    if (!respostaPerdida(leitura.status)) return { tipo: 'parar', mensagem: leitura.mensagem };
    const falhas = estado.falhas + 1;
    if (falhas > ACOMPANHAMENTO.falhasToleradas) return { tipo: 'parar', mensagem: 'O servidor não responde. O trabalho pode continuar lá: confira o histórico em alguns minutos.' };
    return {
      tipo: 'esperar',
      estado: { ...estado, falhas, intervaloMs: recuar(estado.intervaloMs) },
      detalhe: null,
      aviso: falhas >= ACOMPANHAMENTO.falhasParaAvisar ? 'Sem resposta do servidor agora; tentando de novo…' : null,
    };
  }
  const d = leitura.detalhe;
  const continuar = (): PassoAcompanhamento => ({ tipo: 'esperar', estado: { ...estado, falhas: 0, intervaloMs: recuar(estado.intervaloMs) }, detalhe: d, aviso: null });
  if (estado.alvo === 'LEITURA') {
    if (d.status === 'PROCESSANDO') return continuar();
    if (d.status === 'FALHOU') return { tipo: 'falhou', detalhe: d, mensagem: d.erro?.mensagem ?? 'A leitura do arquivo falhou. Envie o arquivo de novo.' };
    return { tipo: 'previa', detalhe: d };
  }
  if (d.processamento?.etapa === 'APLICANDO') return continuar();
  // A SUBSTITUIDA foi aplicada (e outra aplicação do mesmo arquivo veio depois): o resultado dela continua valendo.
  if (d.status === 'APLICADA' || d.status === 'SUBSTITUIDA') return { tipo: 'aplicada', detalhe: d, resultado: d.resultadoAplicacao };
  if (d.status === 'PREVIA') return { tipo: 'falhou', detalhe: d, mensagem: d.erro?.mensagem ?? 'A aplicação não terminou. Confira a prévia e aplique de novo.' };
  return { tipo: 'falhou', detalhe: d, mensagem: 'A importação mudou enquanto era aplicada: confira a situação abaixo.' };
}

// ───────────── período lido das notificações ─────────────

/**
 * Arquivos de um agravo ou de uma ficha só: o DBF do agravo do Sinan Net, o DENGON, o CHIKON e os CSV do e-SUS Sinan e
 * do e-SUS Notifica. O período lido das notificações (a primeira e a última) pode ser bem menor que o da exportação, e o
 * consolidado usa o período lido de qualquer arquivo sem período declarado.
 */
const ARQUIVOS_DE_UM_AGRAVO: readonly TipoArquivoOficial[] = ['AGRAVO_NET', 'DENGON', 'CHIKON', 'ESUS_SINAN_CSV', 'ESUS_NOTIFICA_CSV'];

const dataBr = (iso: string) => {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};

/**
 * Prévia sem período declarado com arquivo de um agravo ou de uma ficha só: o período veio da primeira e da última
 * notificação lidas. Se a exportação cobriu mais (o ano inteiro, por exemplo), as semanas fora dele ficam fora do canal
 * endêmico: melhor descartar e enviar de novo declarando o período. O DBF do agravo junto com o NINDINET não avisa: o
 * NINDINET traz todas as notificações do Sinan Net e cobre o agravo no período dele.
 */
export function avisoPeriodoLido(d: Pick<DetalheImportacao, 'status' | 'periodo' | 'periodoDeclarado' | 'arquivos'>): string | null {
  if (d.status !== 'PREVIA' || d.periodoDeclarado || !d.periodo) return null;
  const validos = d.arquivos.filter((a) => !a.ignorado);
  const comNindinet = validos.some((a) => a.tipo === 'NINDINET');
  if (!validos.some((a) => ARQUIVOS_DE_UM_AGRAVO.includes(a.tipo) && !(comNindinet && a.tipo === 'AGRAVO_NET'))) return null;
  return (
    `O período foi lido das notificações: de ${dataBr(d.periodo.de)} até ${dataBr(d.periodo.ate)}. Se a exportação cobriu mais, por exemplo o ano ` +
    'inteiro, descarte e envie de novo declarando o período: as semanas fora do período lido ficam fora do canal endêmico.'
  );
}

/** Contagens da prévia, na ordem da tela, com o tom de cada número. */
export function linhasDasContagens(c: ContagensImportacao): { chave: string; rotulo: string; valor: number; dica?: string; tom: 'default' | 'good' | 'warn' | 'bad' }[] {
  return [
    { chave: 'lidos', rotulo: 'Lidos', valor: c.lidos, dica: 'registros lidos nos arquivos', tom: 'default' },
    { chave: 'novos', rotulo: 'Novos', valor: c.novos, tom: c.novos ? 'good' : 'default' },
    { chave: 'alterados', rotulo: 'Alterados', valor: c.alterados, tom: 'default' },
    { chave: 'iguais', rotulo: 'Iguais', valor: c.iguais, dica: 'já estão no banco sem mudança', tom: 'default' },
    { chave: 'recusados', rotulo: 'Recusados', valor: c.recusados, tom: c.recusados ? 'bad' : 'default' },
    { chave: 'duplicados', rotulo: 'Duplicados no arquivo', valor: c.duplicadosNoArquivo, dica: 'fica a versão mais completa', tom: c.duplicadosNoArquivo ? 'warn' : 'default' },
    { chave: 'ausentes', rotulo: 'Ausentes previstos', valor: c.ausentesPrevistos, dica: 'estão no banco e não vieram', tom: c.ausentesPrevistos ? 'warn' : 'default' },
  ];
}

/** "Individual: 120 · Negativa: 30 · Surto: 2" (só os tipos presentes). */
export function textoPorTipo(porTipo: ContagensImportacao['porTipo']): string {
  return (['INDIVIDUAL', 'NEGATIVA', 'SURTO'] as TipoRegistroOficial[])
    .filter((t) => porTipo[t])
    .map((t) => `${ROTULO_TIPO_REGISTRO[t]}: ${porTipo[t]!.toLocaleString('pt-BR')}`)
    .join(' · ');
}

/** Motivos de recusa, do mais frequente para o menos. */
export function motivosOrdenados(motivos: Record<string, number>): { motivo: string; quantidade: number }[] {
  return Object.entries(motivos)
    .map(([motivo, quantidade]) => ({ motivo, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade || a.motivo.localeCompare(b.motivo, 'pt-BR'));
}

/** Tempo que falta para a prévia expirar ("Expira em 23 h 10 min"); "A prévia expirou" depois do prazo. */
export function textoExpiracao(expiraEm: string | null, agora: Date): string | null {
  if (!expiraEm) return null;
  const min = Math.floor((Date.parse(expiraEm) - agora.getTime()) / 60_000);
  if (!(min > 0)) return 'A prévia expirou: envie o arquivo de novo.';
  const h = Math.floor(min / 60);
  return `Expira em ${h ? `${h} h ` : ''}${min % 60} min.`;
}

export const ROTULO_ORIGEM_CODIFICACAO: Record<NonNullable<ArquivoDetectado['origemCodificacao']>, string> = {
  CABECALHO: 'pelo cabeçalho do DBF',
  PONTUACAO: 'pelas letras acentuadas',
  INFORMADA: 'informada no envio',
  UTF8: 'UTF-8 válido',
};

/** Formato do arquivo: pela extensão (dentro do zip também) e, sem ela, pelo tipo detectado. */
export function formatoDoArquivo(a: Pick<ArquivoDetectado, 'nome' | 'tipo'>): 'DBF' | 'CSV' | null {
  const ext = extensao(a.nome);
  if (ext === '.dbf') return 'DBF';
  if (ext === '.csv') return 'CSV';
  if (a.tipo === 'ESUS_NOTIFICA_CSV' || a.tipo === 'ESUS_SINAN_CSV') return 'CSV';
  if (a.tipo === 'DESCONHECIDO') return null;
  return 'DBF';
}

/**
 * Codificações que a tela oferece para reprocessar a prévia: no DBF, as páginas de código do DOS e o Windows-1252; no
 * CSV, UTF-8 ou Windows-1252. A escolhida vale para todos os arquivos do envio.
 */
export function codificacoesParaTrocar(arquivos: Pick<ArquivoDetectado, 'nome' | 'tipo' | 'ignorado'>[]): CodificacaoArquivo[] {
  const formatos = new Set(arquivos.filter((a) => !a.ignorado).map(formatoDoArquivo));
  const out: CodificacaoArquivo[] = [];
  if (formatos.has('DBF')) out.push('CP850', 'CP437', 'CP860', 'CP1252');
  if (formatos.has('CSV')) out.push(...(['UTF8', 'CP1252'] as CodificacaoArquivo[]).filter((c) => !out.includes(c)));
  return out;
}

/**
 * Resumo da aplicação, uma frase por resultado que aconteceu. `dataHora` formata o instante no fuso do município (o
 * envio substituído).
 */
export function resumoDaAplicacao(r: ResultadoAplicacao, dataHora: (iso: string) => string = (iso) => dataBr(iso.slice(0, 10))): string[] {
  const n = (x: number) => x.toLocaleString('pt-BR');
  const out = [`${n(r.contagens.novos)} registro(s) novo(s) e ${n(r.contagens.alterados)} alterado(s) gravados.`];
  for (const s of r.substituidas ?? [])
    out.push(
      `Substituiu a aplicação do mesmo arquivo enviada em ${dataHora(s.enviadaEm)} (${periodoBr(s.periodo, s.periodoDeclarado)}): a cobertura passou a ser a deste envio` +
        (s.voltaram ? ` e ${n(s.voltaram)} registro(s) que ela deu como ausentes voltaram.` : '.'),
    );
  if (r.ausentesMarcados) out.push(`${n(r.ausentesMarcados)} registro(s) do mesmo período não vieram e ficaram marcados como ausentes.`);
  if (r.voltaram) out.push(`${n(r.voltaram)} registro(s) ausentes voltaram.`);
  if (r.unidadesLigadas) out.push(`${n(r.unidadesLigadas)} registro(s) ligados à unidade pelo CNES.`);
  if (r.vinculadosAutomaticamente) out.push(`${n(r.vinculadosAutomaticamente)} vínculo(s) automático(s) com as notificações do OmniSaúde.`);
  if (r.negativasCanceladas) out.push(`${n(r.negativasCanceladas)} atesto(s) de notificação negativa cancelado(s): a unidade tinha caso na semana.`);
  return out;
}

/**
 * Detalhes do erro do envio sem registros (SEM_REGISTROS): os arquivos detectados e os motivos de recusa, para a
 * tela mostrar o que a API achou. Qualquer outro formato devolve listas vazias.
 */
export function detalhesDoErroDeEnvio(details: unknown): { arquivos: ArquivoDetectado[]; motivos: { motivo: string; quantidade: number }[] } {
  const d = details && typeof details === 'object' && !Array.isArray(details) ? (details as { arquivos?: unknown; motivosRecusa?: unknown }) : {};
  const arquivos = Array.isArray(d.arquivos) ? (d.arquivos as ArquivoDetectado[]).filter((a) => a && typeof a === 'object' && typeof a.nome === 'string') : [];
  const motivosBrutos = d.motivosRecusa && typeof d.motivosRecusa === 'object' ? (d.motivosRecusa as Record<string, unknown>) : {};
  const motivos = motivosOrdenados(Object.fromEntries(Object.entries(motivosBrutos).filter((e): e is [string, number] => typeof e[1] === 'number')));
  return { arquivos, motivos };
}
