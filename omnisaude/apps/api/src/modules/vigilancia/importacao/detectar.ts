import type { TipoArquivoOficial } from '@omnisaude/shared';
import { unzipSync } from 'fflate';
import { ErroArquivo, type LinhaArquivo } from './dbf';

/**
 * Detecção do tipo de arquivo pelo conteúdo, nunca pelo nome (VIG-1c, frente F2), e abertura do zip (um envio pode
 * trazer vários arquivos). Regras do desenho, §4.1: NINDINET, AGRAVO_NET, NNEGANET, NSURTNET, DENGON/CHIKON,
 * ESUS_NOTIFICA_CSV, ESUS_SINAN_CSV e TABELA_SINAN (ignorada com aviso).
 */

/** Teto do conteúdo descompactado do zip (proteção contra zip bomb). */
export const LIMITE_DESCOMPACTADO_BYTES = 600 * 1024 * 1024;

export interface ArquivoBruto {
  nome: string;
  bytes: Uint8Array;
  /** Arquivo do zip que ficou de fora (motivo): não é .dbf nem .csv. */
  ignorado?: string;
}

const eZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);

/** Arquivos do envio: o zip vira os seus .dbf e .csv (fflate `unzipSync` com filtro e teto); o resto passa como veio. */
export function extrairArquivos(nome: string, bytes: Uint8Array): ArquivoBruto[] {
  if (!eZip(bytes)) return [{ nome, bytes }];
  const ignorados: ArquivoBruto[] = [];
  let total = 0;
  let extraidos: Record<string, Uint8Array>;
  try {
    extraidos = unzipSync(bytes, {
      filter: (f) => {
        const base = f.name.split('/').pop() ?? '';
        if (!base || f.name.endsWith('/') || f.name.startsWith('__MACOSX/') || base.startsWith('.')) return false;
        if (!/\.(dbf|csv)$/i.test(base)) {
          ignorados.push({ nome: f.name, bytes: new Uint8Array(0), ignorado: /\.dbc$/i.test(base) ? 'DBC do DATASUS (compactado) não é lido: use a exportação DBF do Sinan' : 'não é .dbf nem .csv' });
          return false;
        }
        total += f.originalSize;
        if (total > LIMITE_DESCOMPACTADO_BYTES) throw new ErroArquivo('O zip passa de 600 MB descompactado: envie os arquivos em partes', true);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ErroArquivo) throw e;
    throw new ErroArquivo(`Não foi possível abrir o zip (${(e as Error).message})`, true);
  }
  if (ignorados.some((i) => i.nome === '[Content_Types].xml')) throw new ErroArquivo('Planilha do Excel (.xlsx) não é lida: envie o DBF ou o CSV exportado pelo sistema oficial, sem abrir no Excel', true);
  const arquivos = Object.entries(extraidos)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, b]) => ({ nome: n, bytes: b }));
  return [...arquivos, ...ignorados];
}

/** Variáveis da ficha de notificação individual do Sinan Net v5 (comuns, conclusão e internas). */
const COLUNAS_NOTIFICACAO = new Set(
  [
    'nu_notific tp_not id_agravo cs_suspeit in_aids cs_mening dt_notific sem_not nu_ano sg_uf_not id_municip id_regiona id_unidade dt_sin_pri sem_pri',
    'nm_pacient dt_nasc ano_nasc nu_idade_n cs_sexo cs_gestant cs_raca cs_escol_n id_cns_sus nm_mae_pac sg_uf id_mn_resi id_rg_resi id_distrit id_bairro',
    'nm_bairro id_logrado nm_logrado nu_numero nm_complem id_geo1 id_geo2 nm_referen nu_cep nu_ddd_tel nu_telefon cs_zona id_pais nduplic_n in_vincula',
    'dt_invest classi_fin criterio tpautocto coufinf copaisinf comuninf codisinf co_bainfc nobaiinf doenca_tra evolucao dt_obito dt_encerra id_ocupa_n',
    'fonetica_n soundex dt_digita dt_transus dt_transdm dt_transsm dt_transrm dt_transrs dt_transse nu_lote_v nu_lote_h cs_flxret flxrecebi ident_micr',
    'migrado_w tp_sistema tpuninot co_usucad co_usualt',
  ]
    .join(' ')
    .split(' '),
);
/** Colunas que só existem na ficha de surto. */
const COLUNAS_SURTO = ['qt_total_c', 'cs_local', 'dt_prim_si', 'nm_local', 'delimita'];
/** Colunas do paciente (a negativa e o surto não têm). */
const COLUNAS_PACIENTE = ['nm_pacient', 'dt_nasc', 'cs_sexo', 'nu_idade_n', 'nm_mae_pac', 'id_cns_sus'];
/** Tabelas do Sinan (MUNICNET, REGIONET, UF, unidades, bairros, agravos, ocupações): pares id/nome sem notificação. */
const PARES_TABELA = [
  ['id_municip', 'nm_municip'],
  ['id_regiona', 'nm_regiona'],
  ['id_uf', 'nm_uf'],
  ['id_agravo', 'nm_agravo'],
  ['id_unidade', 'nm_unidade'],
  ['id_bairro', 'nm_bairro'],
  ['id_ocupa_n', 'nm_ocupa_n'],
  ['id_pais', 'nm_pais'],
  ['id_distrit', 'nm_distrit'],
  ['id_logrado', 'nm_logrado'],
];

const valores = (amostra: LinhaArquivo[], coluna: string) => amostra.map((l) => (l[coluna] ?? '').trim()).filter(Boolean);
const maioria = (xs: string[], teste: (x: string) => boolean) => xs.length > 0 && xs.filter(teste).length * 2 >= xs.length;
const agravoLimpo = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Tipo do arquivo pelas colunas (normalizadas, em minúsculas) e por uma amostra das linhas. `formato` separa o CSV do
 * e-SUS Sinan (número de 12 dígitos) do DBF do Sinan Net com as mesmas variáveis.
 */
export function detectarTipo(colunas: string[], amostra: LinhaArquivo[], formato: 'DBF' | 'CSV' = 'DBF'): TipoArquivoOficial {
  const tem = (c: string) => colunas.includes(c);
  if (tem('numero da notificacao') && (tem('cnes notificacao') || tem('data da notificacao'))) return 'ESUS_NOTIFICA_CSV';
  if (!tem('nu_notific')) {
    if (PARES_TABELA.some(([id, nome]) => tem(id!) && tem(nome!)) || (tem('sg_uf') && tem('nm_uf'))) return 'TABELA_SINAN';
    return 'DESCONHECIDO';
  }
  const tpNot = valores(amostra, 'tp_not');
  if (COLUNAS_SURTO.some(tem) || maioria(tpNot, (v) => v === '3')) return 'NSURTNET';
  const semPaciente = !COLUNAS_PACIENTE.some(tem);
  if (maioria(tpNot, (v) => v === '1') || (!tem('id_agravo') && semPaciente && tem('id_unidade'))) return 'NNEGANET';
  if (!tem('id_agravo')) return 'DESCONHECIDO';
  const agravos = valores(amostra, 'id_agravo').map(agravoLimpo);
  if (formato === 'CSV' && maioria(valores(amostra, 'nu_notific'), (v) => /^\d{12}$/.test(v))) return 'ESUS_SINAN_CSV';
  // Sinan Online (dengue e chikungunya): TP_SISTEMA 2, CLASSI_FIN 10 a 13 ou a apresentação clínica da chikungunya.
  const classificacoes = valores(amostra, 'classi_fin').map((v) => v.replace(/^0+(?=\d)/, ''));
  const online = maioria(valores(amostra, 'tp_sistema'), (v) => v === '2') || classificacoes.some((v) => ['10', '11', '12', '13'].includes(v)) || tem('clinc_chik');
  if (online) {
    const chik = agravos.filter((a) => a.startsWith('A92')).length;
    const dengue = agravos.filter((a) => a.startsWith('A90')).length;
    if (chik !== dengue) return chik > dengue ? 'CHIKON' : 'DENGON';
    if (classificacoes.includes('13') && !classificacoes.some((v) => ['10', '11', '12'].includes(v))) return 'CHIKON';
    if (classificacoes.some((v) => ['10', '11', '12'].includes(v))) return 'DENGON';
    return tem('clinc_chik') ? 'CHIKON' : 'DENGON';
  }
  // O NINDINET traz todos os agravos; o DBF do agravo, um só. Com um ou dois agravos na amostra, decide a ficha de
  // investigação: alguma coluna fora da notificação individual (e do bloco de conclusão).
  if (new Set(agravos).size >= 3) return 'NINDINET';
  if (colunas.some((c) => !COLUNAS_NOTIFICACAO.has(c))) return 'AGRAVO_NET';
  return 'NINDINET';
}
