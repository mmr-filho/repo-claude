import {
  ROTULO_TIPO_REGISTRO,
  type ArquivoDetectado,
  type ArquivoJaImportado,
  type CodificacaoArquivo,
  type ContagensImportacao,
  type RespostaEnvioImportacao,
  type ResultadoAplicacao,
  type ResumoImportacao,
  type TipoRegistroOficial,
} from '@omnisaude/shared';

/*
 * Regras da aba Importação (envio das exportações oficiais, prévia, aplicar e descartar), sem React (testadas em
 * apps/web/test/importacao-regras.test.ts). Os limites são os da API.
 */

/** Teto do envio na API, antes de descompactar. */
export const LIMITE_ENVIO_BYTES = 95 * 1024 * 1024;

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

/** Situação da importação na lista: a prévia descartada pelo tempo aparece como "Expirada". */
export function situacaoImportacao(r: Pick<ResumoImportacao, 'status' | 'expirada'>): { rotulo: string; tom: 'blue' | 'green' | 'amber' | 'slate' } {
  if (r.status === 'PREVIA') return { rotulo: 'Prévia', tom: 'blue' };
  if (r.status === 'APLICADA') return { rotulo: 'Aplicada', tom: 'green' };
  return r.expirada ? { rotulo: 'Expirada', tom: 'amber' } : { rotulo: 'Descartada', tom: 'slate' };
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

/** Resumo da aplicação, uma frase por resultado que aconteceu. */
export function resumoDaAplicacao(r: ResultadoAplicacao): string[] {
  const n = (x: number) => x.toLocaleString('pt-BR');
  const out = [`${n(r.contagens.novos)} registro(s) novo(s) e ${n(r.contagens.alterados)} alterado(s) gravados.`];
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
