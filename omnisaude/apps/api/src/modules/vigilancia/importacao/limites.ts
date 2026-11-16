/**
 * Tetos da importação (VIG-1c), dimensionados para o container de 1 GiB da produção (cerca de 512 MB de heap). O envio é
 * lido em fluxo: o arquivo descompactado nunca fica inteiro na memória, os registros normalizados vão para um arquivo
 * temporário e o payload da prévia é lido em lotes. O que cresce com o envio é só o índice das chaves (perto de 150
 * bytes por registro), por isso o teto de registros.
 */

/** Teto do conteúdo descompactado do envio inteiro (soma dos arquivos). */
export const LIMITE_DESCOMPACTADO_BYTES = 150 * 1024 * 1024;

/** Teto de linhas lidas no envio inteiro (soma dos arquivos, recusadas inclusive). */
export const LIMITE_REGISTROS = 400_000;

/** Teto de uma linha (registro) do CSV: acima disso, quase sempre é aspa sem fechamento. */
export const LIMITE_LINHA_BYTES = 1024 * 1024;

/** O que fazer quando um teto estoura. */
export const DICA_TETO = 'Exporte um ano por vez (ou um período menor) e envie em partes.';

export const mensagemTetoBytes = () => `O envio passa de ${LIMITE_DESCOMPACTADO_BYTES / 1024 / 1024} MB descompactado. ${DICA_TETO}`;
export const mensagemTetoRegistros = () => `O envio passa de ${(LIMITE_REGISTROS / 1000).toLocaleString('pt-BR')} mil registros. ${DICA_TETO}`;
